'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { SendHorizonal, MessageSquare, Square } from 'lucide-react';
import { MarkdownView } from '@/components/MarkdownView';
import { Button, EmptyState, Skeleton } from '@/components/ui';

interface Turn {
  question: string;
  answer: string;
  sources: string[];
  done: boolean;
  error?: string;
  /** What the agent is doing right now, e.g. "Reading index.md". Shown only while it works. */
  activity?: string;
}

/**
 * Chat scoped to one cluster.
 *
 * Uses fetch + a stream reader rather than EventSource, because the question
 * has to go up in a POST body and EventSource is GET-only. The wire format is
 * still SSE, so it inherits the same proxy behaviour.
 *
 * The answer is rendered as it arrives, in the reading view's own typography,
 * and the pages it names become links.
 */
export function ChatPanel({
  cluster,
  hasPages,
  titles,
}: {
  cluster: string;
  hasPages: boolean;
  /** title -> slug, as pairs. A Map does not survive the trip from the server on every version of React. */
  titles: [string, string][];
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const known = useMemo(() => new Map(titles), [titles]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  async function ask() {
    const text = question.trim();
    if (!text || busy) return;

    setQuestion('');
    setBusy(true);
    setTurns((t) => [...t, { question: text, answer: '', sources: [], done: false }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster, question: text }),
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

          if (event === 'token') {
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

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="content space-y-7">
          {turns.length === 0 && (
            <p className="max-w-prose text-body text-muted">
              Ask anything this cluster covers. Answers come with the pages they were drawn from, so
              you can read the source yourself rather than take the answer on trust.
            </p>
          )}

          {turns.map((turn, i) => (
            <section key={i}>
              <h2 className="text-body font-semibold text-ink">{turn.question}</h2>

              <div className="mt-2">
                {turn.error ? (
                  <p role="alert" className="text-body text-danger">
                    {turn.error}
                  </p>
                ) : turn.answer ? (
                  <div className="preview compact">
                    <MarkdownView source={stripSources(turn.answer)} cluster={cluster} titles={known} />
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

              {turn.sources.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-small text-muted">From</span>
                  {turn.sources.map((source) => {
                    const slug = known.get(source.toLowerCase());
                    return slug ? (
                      <Link key={source} href={`/c/${cluster}/${slug}`} className="tag">
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
            placeholder={`Ask something the ${cluster} cluster covers…`}
            aria-label="Your question"
          />
          {busy ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()} aria-label="Stop">
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

function patchLast(turns: Turn[], fn: (turn: Turn) => Turn): Turn[] {
  if (turns.length === 0) return turns;
  return [...turns.slice(0, -1), fn(turns[turns.length - 1])];
}

/** The prompt asks for a trailing `SOURCES: [[A]], [[B]]` line. Lift it out of
 *  the prose and render it as citations. */
function finalise(turn: Turn): Turn {
  const match = turn.answer.match(/^SOURCES:\s*(.+)$/m);
  const sources = match
    ? [...match[1].matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim())
    : [];
  return { ...turn, sources, done: true };
}

function stripSources(answer: string): string {
  return answer.replace(/^SOURCES:.*$/m, '').trim();
}
