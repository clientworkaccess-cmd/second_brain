'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, AudioLines, BookOpen, Globe, Mic, SendHorizonal, MessageSquare, MessageSquarePlus, PenLine, Square, Undo2, Volume2, X } from 'lucide-react';
import { MarkdownView } from '@/components/MarkdownView';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { DEFAULT_MODEL, MODELS, familyOf, modelChoice, type ModelChoice } from '@/lib/models';
import { pageHref, resolveLink } from '@/lib/wikilinks';
import { CONVERSATIONS_CHANGED } from '@/components/conversationEvents';
import { useVoice } from '@/components/useVoice';
import { joinDictation, withoutCitations } from '@/lib/speech';

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
  /** The reader let it look on the web for this message. */
  web?: boolean;
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
 * In Discuss the reader can switch the web on, message by message; never in
 * Work. What the reader said is set apart from the replies, in a box to the
 * right, as in Claude; replies are set in a serif face. The view follows a
 * reply as it arrives only while the reader is at the bottom, and an arrow
 * brings them back down.
 *
 * Voice, where the browser has it (components/useVoice.ts): the microphone
 * dictates into the question box; an answer can be read aloud; and "Talk" is
 * a conversation by voice: speak, pause, hear the answer, speak again. The
 * speech is the browser's own, not Claude's.
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
  const [web, setWeb] = useState(false);
  const [away, setAway] = useState(false);
  /** The turn whose sources are open in the modal, or null. */
  const [sourcesFor, setSourcesFor] = useState<number | null>(null);
  const sourcesRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the reader is at the bottom: only then does the view follow a reply as it arrives. */
  const followRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  /** What was in the box when the microphone opened; dictation is added to it. */
  const typedRef = useRef('');
  const askRef = useRef<(said?: string) => void>(() => {});
  const voice = useVoice({
    onDictation: (settled, unsettled) => setQuestion(joinDictation(typedRef.current, `${settled} ${unsettled}`)),
    onUtterance: (said) => askRef.current(said),
  });

  // The box grows with what is in it, up to a few lines, then scrolls.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
  }, [question]);
  // A native modal: it traps focus, closes on Escape and dims what is behind it.
  useEffect(() => {
    const dialog = sourcesRef.current;
    if (!dialog) return;
    if (sourcesFor !== null && !dialog.open) dialog.showModal();
    else if (sourcesFor === null && dialog.open) dialog.close();
  }, [sourcesFor]);
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

  // Whether the web is on is remembered per wiki, like the model.
  useEffect(() => {
    try {
      setWeb(localStorage.getItem(`sb-chat-web:${cluster}`) === 'on');
    } catch {
      /* off, then */
    }
  }, [cluster]);
  const chooseWeb = (next: boolean): void => {
    setWeb(next);
    try {
      localStorage.setItem(`sb-chat-web:${cluster}`, next ? 'on' : 'off');
    } catch {
      /* lasts for this page */
    }
  };

  // Follow the reply down only while the reader is already at the bottom; someone reading further up is left there.
  useEffect(() => {
    const el = scrollRef.current;
    if (followRef.current && el) el.scrollTop = el.scrollHeight;
  }, [turns]);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = fromBottom < 80;
    setAway(fromBottom > 240);
  };
  const toBottom = (): void => {
    followRef.current = true;
    setAway(false);
    // Glides when the page is in view; a page in the background does not animate, so there it jumps.
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: document.hidden ? 'auto' : 'smooth' });
  };

  const changed = (): void => {
    window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
  };

  async function startAfresh() {
    if (busy) return;
    router.push(`/c/${cluster}/ask?new`);
  }

  async function ask(said?: string) {
    const text = (said ?? question).trim();
    if (!text || busy) return;
    // The microphone closes while the answer comes; in a conversation it opens again after it is said.
    voice.beginAnswer();

    setQuestion('');
    setBusy(true);
    const useWeb = mode === 'discuss' && web;
    // Sending a message brings the reader to it.
    followRef.current = true;
    setTurns((t) => [...t, { question: text, answer: '', sources: [], done: false, mode, model, web: useWeb }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let wrote = false;
    let startedId: string | null = null;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster, question: text, conversation: id, model: modelChoice(model), mode, web: useWeb }),
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
            voice.feed(chunk);
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
            voice.feed('\nSorry, that did not work.\n');
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
        voice.feed('\nSorry, that did not work.\n');
      }
    } finally {
      // In a conversation: say what is left of the answer, then listen again.
      voice.finishAnswer();
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

  askRef.current = (said) => void ask(said);
  const talking = voice.phase !== 'off';
  const stop = (): void => {
    abortRef.current?.abort();
    if (talking) voice.interrupt();
  };

  const pageName = (slug: string): string => bySlug.get(slug) ?? slug.split('/').pop() ?? slug;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="content space-y-7">
          {turns.length === 0 ? (
            <p className="max-w-prose text-body text-muted">
              Talk to your brain. Ask what it knows, think something through, and keep going: the conversation is kept and what was said is remembered.
              Switch to <strong>Work</strong> to have it write things down as you go; every change it makes can be undone.
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
              <div className="chat-said">
                {turn.mode === 'work' && (
                  <span className="chat-mode-tag" title="Said in Work: it could change the brain">
                    Work
                  </span>
                )}
                {turn.web && (
                  <span className="chat-mode-tag" title="It could look on the web for this message">
                    Web
                  </span>
                )}
                <h2 className="chat-said-bubble">{turn.question}</h2>
              </div>

              <div className="chat-reply mt-3">
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

              {turn.done && !turn.error && (turn.answeredBy || turn.model || (voice.canSpeak && turn.answer) || turn.sources.length > 0) && (
                <p className="mt-2 flex items-center gap-2 text-small text-faint">
                  {voice.canSpeak && turn.answer && !talking && (
                    <button
                      type="button"
                      className={`chat-read${voice.reading === String(i) ? ' active' : ''}`}
                      aria-pressed={voice.reading === String(i)}
                      title={voice.reading === String(i) ? 'Stop reading' : 'Read this answer aloud'}
                      onClick={() => (voice.reading === String(i) ? voice.stopReading() : voice.read(String(i), turn.answer))}
                    >
                      {voice.reading === String(i) ? <Square size={12} /> : <Volume2 size={13} />}
                      <span>{voice.reading === String(i) ? 'Stop' : 'Read aloud'}</span>
                    </button>
                  )}
                  <span title={turn.answeredBy ?? undefined}>
                    {familyOf(turn.answeredBy) ?? MODELS.find((m) => m.id === turn.model)?.label}
                    {turn.model && turn.model !== 'default' && familyOf(turn.answeredBy) && familyOf(turn.answeredBy)?.toLowerCase() !== turn.model ? ` (asked for ${MODELS.find((m) => m.id === turn.model)?.label})` : ''}
                  </span>
                  {turn.sources.length > 0 && (
                    <button type="button" className="chat-sources-tag" aria-haspopup="dialog" title="The pages this reply was drawn from" onClick={() => setSourcesFor(i)}>
                      <BookOpen size={12} />
                      <span>
                        {turn.sources.length} {turn.sources.length === 1 ? 'source' : 'sources'}
                      </span>
                    </button>
                  )}
                </p>
              )}
            </section>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {away && (
        <button type="button" className="chat-to-bottom" onClick={toBottom} aria-label="Go to the latest message" title="Go to the latest message">
          <ArrowDown size={16} />
        </button>
      )}

      <dialog
        ref={sourcesRef}
        className="sources-modal"
        aria-label="Sources"
        onClose={() => setSourcesFor(null)}
        // A click on the dimmed backdrop lands on the dialog itself, not on its body.
        onClick={(e) => {
          if (e.target === e.currentTarget) setSourcesFor(null);
        }}
      >
        <div className="sources-modal-body">
          <div className="sources-modal-head">
            <span>Sources</span>
            <button type="button" className="sources-modal-close" aria-label="Close" onClick={() => setSourcesFor(null)}>
              <X size={14} />
            </button>
          </div>
          <ul className="sources-modal-list">
            {(sourcesFor !== null ? (turns[sourcesFor]?.sources ?? []) : []).map((source) => {
              const slug = resolveLink(known, source);
              return (
                <li key={source}>
                  {slug ? (
                    <Link href={pageHref(cluster, slug)} onClick={() => setSourcesFor(null)}>
                      {source}
                    </Link>
                  ) : (
                    <span className="text-faint" title="No page by this name in the brain">
                      {source}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </dialog>

      <div className="chat-composer">
        <div className="chat-composer-inner">
          {talking && (
            <div className="chat-voice" aria-live="polite">
              <span className={`chat-voice-dot ${voice.phase}`} />
              <span className="chat-voice-text">
                {voice.phase === 'listening' ? voice.heard || 'Listening. Speak, then pause.' : voice.phase === 'thinking' ? 'Thinking…' : 'Speaking…'}
              </span>
              <span className="statusbar-spacer" />
              {voice.phase !== 'listening' && (
                <button type="button" className="graph-toggle" onClick={stop} title="Stop the answer and listen again">
                  Interrupt
                </button>
              )}
              <button type="button" className="graph-toggle" onClick={voice.stopConversation} title="End the conversation by voice">
                End
              </button>
            </div>
          )}
          {voice.error && (
            <p role="alert" className="chat-voice-error">
              {voice.error}
              <button type="button" onClick={voice.clearError} aria-label="Dismiss">
                ×
              </button>
            </p>
          )}
          <textarea
            ref={boxRef}
            rows={1}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder={mode === 'work' ? 'Ask, or say what to write down…' : 'Message your brain…'}
            aria-label="Your question"
          />
          <div className="chat-composer-row">
          <div className="chat-mode" role="radiogroup" aria-label="Whether it may change the brain">
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
          <button
            type="button"
            className={`chat-voice-button wide${web && mode === 'discuss' ? ' active' : ''}`}
            aria-pressed={web && mode === 'discuss'}
            disabled={busy || mode === 'work'}
            title={
              mode === 'work'
                ? 'The web is for Discuss only: a turn that can write never looks on the web'
                : web
                  ? 'It may look on the web for your messages. Click to keep it to the brain.'
                  : 'Let it look on the web as well as in the brain'
            }
            onClick={() => chooseWeb(!web)}
          >
            <Globe size={14} />
            <span>Web</span>
          </button>
          <span className="statusbar-spacer" />
          {voice.canListen && (
            <button
              type="button"
              className={`chat-voice-button${voice.dictating ? ' active' : ''}`}
              aria-pressed={voice.dictating}
              aria-label={voice.dictating ? 'Stop dictating' : 'Dictate'}
              title={voice.dictating ? 'Stop dictating' : 'Dictate: speak, and it is typed into the box'}
              disabled={busy || talking}
              onClick={() => {
                if (voice.dictating) voice.stopDictation();
                else {
                  typedRef.current = question;
                  voice.startDictation();
                }
              }}
            >
              <Mic size={15} />
            </button>
          )}
          {voice.canListen && voice.canSpeak && (
            <button
              type="button"
              className={`chat-voice-button wide${talking ? ' active' : ''}`}
              aria-pressed={talking}
              title={talking ? 'End the conversation by voice' : 'Talk: speak, pause, and hear the answer; then speak again'}
              disabled={busy && !talking}
              onClick={() => (talking ? voice.stopConversation() : voice.startConversation())}
            >
              <AudioLines size={15} />
              <span>{talking ? 'End' : 'Talk'}</span>
            </button>
          )}
          {busy ? (
            <Button variant="ghost" onClick={stop} aria-label="Stop" title={mode === 'work' ? 'Stops showing it; a turn that may write is let finish, and appears here when you come back' : 'Stop'}>
              <Square size={14} />
              Stop
            </Button>
          ) : (
            <Button onClick={() => void ask()} disabled={!question.trim()} aria-label="Ask">
              <SendHorizonal size={15} />
              Ask
            </Button>
          )}
          </div>
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

/** The SOURCES and WROTE lines are shown apart from the reply, and a reply carries no citations in its text. */
function stripTrailers(answer: string): string {
  return withoutCitations(answer.replace(/^(SOURCES|WROTE):.*$/gm, '')).trim();
}
