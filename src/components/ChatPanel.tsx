'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SendHorizonal, MessageSquare, MessageSquarePlus, PenLine, Square, Undo2 } from 'lucide-react';
import { MarkdownView } from '@/components/MarkdownView';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { DEFAULT_MODEL, MODELS, familyOf, modelChoice, type ModelChoice } from '@/lib/models';
import { pageHref, resolveLink } from '@/lib/wikilinks';
import { CONVERSATIONS_CHANGED } from '@/components/conversationEvents';

type Mode = 'discuss' | 'work';

interface Finding {
  severity: 'error' | 'warning';
  detail: string;
}

export interface ChatTurn {
  question: string;
  answer: string;
  sources: string[];
  done: boolean;
  error?: string;
  /** What the agent is doing right now, e.g. "Reading index.md". Shown only while it works. */
  activity?: string;
  mode?: Mode;
  /** The model asked for, and the one that answered as the binary reported it. */
  model?: string;
  answeredBy?: string | null;
  /** Pages this turn created, changed or removed, by slug; and its restore point. */
  wrote?: string[];
  commit?: string | null;
  undone?: boolean;
  findings?: Finding[];
}

export interface ChatConversation {
  id: string;
  title: string;
  mode: Mode;
  model: string | null;
  turns: ChatTurn[];
}


/**
 * One conversation with one wiki.
 *
 * What was said is kept by the server (lib/conversations.ts), so the thread is
 * the same in every browser and after a reload. The agent remembers it too: it
 * resumes the session it kept, or, when that is gone, is given a recap.
 *
 * Beside the question: Discuss (the agent reads, and cannot change anything)
 * or Work (it may write pages, as a filing does; what it wrote is checked,
 * kept as one restore point, and can be undone from here). And the model
 * (lib/models.ts). Both are remembered with the conversation.
 *
 * Uses fetch + a stream reader rather than EventSource, because the question
 * goes up in a POST body. The wire format is still SSE.
 */
export function ChatPanel({
  cluster,
  hasPages,
  titles,
  conversation,
}: {
  cluster: string;
  hasPages: boolean;
  /** title -> slug, as pairs. A Map does not survive the trip from the server on every version of React. */
  titles: [string, string][];
  conversation: ChatConversation | null;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<ChatTurn[]>(conversation?.turns ?? []);
  const [id, setId] = useState<string | null>(conversation?.id ?? null);
  const [title, setTitle] = useState<string>(conversation?.title ?? 'This conversation');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(conversation?.mode ?? 'discuss');
  const [model, setModel] = useState<ModelChoice['id']>((conversation?.model as ModelChoice['id'] | null) ?? DEFAULT_MODEL);
  const [undoing, setUndoing] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const known = useMemo(() => new Map(titles), [titles]);
  const bySlug = useMemo(() => new Map(titles.map(([title, slug]) => [slug, title])), [titles]);

  // A new conversation starts with the model chosen last time in this wiki.
  useEffect(() => {
    if (conversation) return;
    try {
      const chosen = localStorage.getItem(`sb-chat-model:${cluster}`);
      if (chosen && MODELS.some((m) => m.id === chosen)) setModel(chosen as ModelChoice['id']);
    } catch {
      /* the default, then */
    }
  }, [cluster, conversation]);
  const chooseModel = (next: ModelChoice['id']): void => {
    setModel(next);
    try {
      localStorage.setItem(`sb-chat-model:${cluster}`, next);
    } catch {
      /* lasts for this page */
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const changed = (): void => {
    window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
  };

  async function startAfresh() {
    if (busy) return;
    router.push(`/c/${cluster}/ask?new`);
  }

  async function ask() {
    const text = question.trim();
    if (!text || busy) return;

    setQuestion('');
    setBusy(true);
    setTurns((t) => [...t, { question: text, answer: '', sources: [], done: false, mode, model }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let wrote = false;
    let startedId: string | null = null;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster, question: text, conversation: id, model: modelChoice(model), mode }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'The agent could not be reached');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const raw = frame.match(/^data: (.*)$/m)?.[1];
          if (!event || !raw) continue;

          if (event === 'conversation') {
            const { id: given } = JSON.parse(raw) as { id: string };
            if (given !== id) startedId = given;
            setId(given);
          } else if (event === 'token') {
            const { text: chunk } = JSON.parse(raw) as { text: string };
            setTurns((t) => patchLast(t, (turn) => ({ ...turn, answer: turn.answer + chunk })));
          } else if (event === 'activity') {
            const { text: doing } = JSON.parse(raw) as { text: string };
            setTurns((t) => patchLast(t, (turn) => ({ ...turn, activity: doing })));
          } else if (event === 'final') {
            // The answer as the agent settled on it. Anything it said along the
            // way, before it had read what it needed, is not part of it.
            const { text: whole } = JSON.parse(raw) as { text: string };
            if (whole.trim()) setTurns((t) => patchLast(t, (turn) => ({ ...turn, answer: whole })));
          } else if (event === 'end') {
            const end = JSON.parse(raw) as { model?: string | null; title?: string; wrote?: string[]; commit?: string | null; findings?: Finding[] };
            wrote = (end.wrote?.length ?? 0) > 0;
            if (end.title) setTitle(end.title);
            setTurns((t) => patchLast(t, (turn) => ({ ...turn, answeredBy: end.model ?? null, wrote: end.wrote ?? [], commit: end.commit ?? null, findings: end.findings ?? [] })));
          } else if (event === 'error') {
            const { message } = JSON.parse(raw) as { message: string };
            setTurns((t) => patchLast(t, (turn) => ({ ...turn, error: message, done: true })));
          }
        }
      }

      setTurns((t) => patchLast(t, finalise));
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setTurns((t) => patchLast(t, (turn) => ({ ...turn, done: true })));
      } else {
        const message = err instanceof Error ? err.message : 'Something went wrong';
        setTurns((t) => patchLast(t, (turn) => ({ ...turn, error: message, done: true })));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      changed();
      // A conversation that has just begun gets its own address, so a reload or a link reopens it.
      if (startedId) window.history.replaceState(null, '', `/c/${cluster}/ask/${startedId}`);
      // Pages changed: the tree, the graph and the page views read them again.
      if (wrote) router.refresh();
    }
  }

  async function undo(index: number) {
    if (!id || undoing !== null) return;
    setUndoing(index);
    try {
      const res = await fetch('/api/conversations/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster, id, turn: index }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'That could not be undone');
      setTurns((t) => t.map((turn, i) => (i === index ? { ...turn, undone: true } : turn)));
      changed();
      router.refresh();
    } catch (err) {
      setTurns((t) => t.map((turn, i) => (i === index ? { ...turn, findings: [...(turn.findings ?? []), { severity: 'error', detail: err instanceof Error ? err.message : 'That could not be undone' }] } : turn)));
    } finally {
      setUndoing(null);
    }
  }

  if (!hasPages) {
    return (
      <div className="center-scroll">
        <div className="content">
          <EmptyState
            icon={MessageSquare}
            title="Nothing to ask yet"
            body="Once a document has been filed into this cluster, you can ask questions about it and get answers with the pages they came from."
            action={
              <Link href={`/c/${cluster}`} className="text-link hover:underline">
                Add a document first
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const pageName = (slug: string): string => bySlug.get(slug) ?? slug.split('/').pop() ?? slug;

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="content space-y-7">
          {turns.length === 0 ? (
            <p className="max-w-prose text-body text-muted">
              Ask anything this wiki covers, and keep going: the conversation is kept, and the agent remembers what was said. Answers come with the pages
              they were drawn from. Switch to <strong>Work</strong> to let it write pages as you go; every change it makes can be undone.
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <span className="section-title">{title}</span>
              <span className="statusbar-spacer" />
              <Button variant="quiet" onClick={startAfresh} disabled={busy} title="Start a new conversation; this one stays in the list">
                <MessageSquarePlus size={14} />
                New conversation
              </Button>
            </div>
          )}

          {turns.map((turn, i) => (
            <section key={i}>
              <h2 className="flex items-baseline gap-2 text-body font-semibold text-ink">
                {turn.mode === 'work' && (
                  <span className="chat-mode-tag" title="Asked in Work: it could change the wiki">
                    Work
                  </span>
                )}
                <span>{turn.question}</span>
              </h2>

              <div className="mt-2">
                {turn.error ? (
                  <p role="alert" className="text-body text-danger">
                    {turn.error}
                  </p>
                ) : turn.answer ? (
                  <div className="preview compact">
                    <MarkdownView source={stripTrailers(turn.answer)} cluster={cluster} titles={known} />
                  </div>
                ) : (
                  <div className="space-y-2" aria-label="Waiting for the answer">
                    <Skeleton className="h-3 w-5/6" />
                    <Skeleton className="h-3 w-4/6" />
                    <Skeleton className="h-3 w-3/6" />
                  </div>
                )}
              </div>

              {!turn.done && !turn.error && turn.activity && (
                <p className="mt-2 text-small text-muted" aria-live="polite">
                  {turn.activity}…
                </p>
              )}

              {(turn.wrote?.length ?? 0) > 0 && (
                <div className={`chat-wrote${turn.undone ? ' undone' : ''}`}>
                  <PenLine size={13} className="flex-none" />
                  <span className="text-small">{turn.undone ? 'Undone:' : 'Changed:'}</span>
                  {turn.wrote!.map((slug) =>
                    turn.undone ? (
                      <span key={slug} className="tag">
                        {pageName(slug)}
                      </span>
                    ) : (
                      <Link key={slug} href={pageHref(cluster, slug)} className="tag">
                        {pageName(slug)}
                      </Link>
                    ),
                  )}
                  <span className="statusbar-spacer" />
                  {turn.commit && !turn.undone && (
                    <button type="button" className="graph-toggle" disabled={undoing !== null || busy} onClick={() => void undo(i)} title="Put these pages back as they were before this turn">
                      <Undo2 size={13} />
                      {undoing === i ? 'Undoing…' : 'Undo'}
                    </button>
                  )}
                </div>
              )}

              {(turn.findings?.length ?? 0) > 0 && !turn.undone && (
                <ul className="mt-2 space-y-0.5 text-small">
                  {turn.findings!.slice(0, 6).map((f, k) => (
                    <li key={k} className={f.severity === 'error' ? 'text-danger' : 'text-warning'}>
                      {f.detail}
                    </li>
                  ))}
                </ul>
              )}

              {turn.done && !turn.error && (turn.answeredBy || turn.model) && (
                <p className="mt-2 text-small text-faint" title={turn.answeredBy ?? undefined}>
                  {familyOf(turn.answeredBy) ?? MODELS.find((m) => m.id === turn.model)?.label}
                  {turn.model && turn.model !== 'default' && familyOf(turn.answeredBy) && familyOf(turn.answeredBy)?.toLowerCase() !== turn.model ? ` (asked for ${MODELS.find((m) => m.id === turn.model)?.label})` : ''}
                </p>
              )}

              {turn.sources.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-small text-muted">From</span>
                  {turn.sources.map((source) => {
                    const slug = resolveLink(known, source);
                    return slug ? (
                      <Link key={source} href={pageHref(cluster, slug)} className="tag">
                        {source}
                      </Link>
                    ) : (
                      <span key={source} className="tag">
                        {source}
                      </span>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="chat-composer">
        <div className="chat-composer-inner">
          <textarea
            rows={1}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder={mode === 'work' ? 'Ask, or say what to write down…' : `Ask something the ${cluster} wiki covers…`}
            aria-label="Your question"
          />
          <div className="chat-mode" role="radiogroup" aria-label="Whether the agent may change the wiki">
            {(['discuss', 'work'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? 'active' : ''}
                disabled={busy}
                title={m === 'discuss' ? 'The agent reads and answers; it cannot change anything' : 'The agent may write pages when you ask it to; every change can be undone'}
                onClick={() => setMode(m)}
              >
                {m === 'discuss' ? 'Discuss' : 'Work'}
              </button>
            ))}
          </div>
          <select
            className="chat-model"
            aria-label="Which model answers"
            title={MODELS.find((m) => m.id === model)?.hint}
            value={model}
            disabled={busy}
            onChange={(e) => chooseModel(e.target.value as ModelChoice['id'])}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
          {busy ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()} aria-label="Stop" title={mode === 'work' ? 'Stops showing it; a turn that may write is let finish, and appears here when you come back' : 'Stop'}>
              <Square size={14} />
              Stop
            </Button>
          ) : (
            <Button onClick={ask} disabled={!question.trim()} aria-label="Ask">
              <SendHorizonal size={15} />
              Ask
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function patchLast(turns: ChatTurn[], fn: (turn: ChatTurn) => ChatTurn): ChatTurn[] {
  if (turns.length === 0) return turns;
  return [...turns.slice(0, -1), fn(turns[turns.length - 1])];
}

/** The prompt asks for a trailing `SOURCES: [[A]], [[B]]` line. Lift it out of
 *  the prose and render it as citations. */
function finalise(turn: ChatTurn): ChatTurn {
  const match = turn.answer.match(/^SOURCES:\s*(.+)$/m);
  const sources = match ? [...match[1].matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()) : turn.sources;
  return { ...turn, sources, done: true };
}

/** The SOURCES and WROTE lines are shown as links, not as text. */
function stripTrailers(answer: string): string {
  return answer.replace(/^(SOURCES|WROTE):.*$/gm, '').trim();
}
