'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SendHorizonal, MessageSquare, Square } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui';

interface Turn {
  question: string;
  answer: string;
  sources: string[];
  done: boolean;
  error?: string;
}

/**
 * Chat scoped to one cluster.
 *
 * Uses fetch + a stream reader rather than EventSource, because the question
 * has to go up in a POST body and EventSource is GET-only. The wire format is
 * still SSE, so it inherits the same proxy behaviour.
 *
 * Whether text actually arrives incrementally depends on whether `hermes -z`
 * emits mid-run — unverified. This renders correctly either way: token by
 * token if it streams, one block at the end if it does not.
 */
export function ChatPanel({ cluster, hasPages }: { cluster: string; hasPages: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
      <EmptyState
        icon={MessageSquare}
        title="Nothing to ask yet"
        body="Once a document has been filed into this cluster, you can ask questions about it and get answers with the pages they came from."
        action={
          <Link href={`/c/${cluster}`} className="text-lavender underline underline-offset-4 decoration-lavender/40 hover:decoration-lavender">
            Add a document first
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex min-h-[60dvh] flex-col">
      <div className="flex-1 space-y-6">
        {turns.length === 0 && (
          <p className="max-w-prose text-body text-medium">
            Ask anything this cluster covers. Answers come with the pages they were drawn from,
            so you can read the source yourself rather than take the answer on trust.
          </p>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="space-y-3">
            <p className="text-bright font-medium text-body">{turn.question}</p>

            {turn.error ? (
              <p className="text-body-sm text-error">{turn.error}</p>
            ) : turn.answer ? (
              <div className="md whitespace-pre-wrap">{stripSources(turn.answer)}</div>
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-4/6" />
                <Skeleton className="h-3 w-3/6" />
              </div>
            )}

            {turn.sources.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-caption text-muted">From</span>
                {turn.sources.map((source) => (
                  <span
                    key={source}
                    className="rounded-full border border-lavender/30 bg-tag-bg px-2.5 py-0.5 text-caption font-medium text-lavender"
                  >
                    {source}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <Card className="sticky bottom-4 mt-8 p-2 border border-graphite bg-surface shadow-subtle">
        <div className="flex items-end gap-2">
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
            placeholder={
              cluster.toLowerCase() === 'finance'
                ? 'Ask what the Finance cluster is about...'
                : cluster.toLowerCase() === 'marketing'
                ? 'Ask what the Marketing cluster is about...'
                : 'Ask what the Operations cluster is about...'
            }
            className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2.5 text-body text-bright placeholder:text-muted/60 focus:outline-none"
          />
          {busy ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()} aria-label="Stop">
              <Square className="h-4 w-4" strokeWidth={2} />
              Stop
            </Button>
          ) : (
            <Button onClick={ask} disabled={!question.trim()} aria-label="Ask">
              <SendHorizonal className="h-4 w-4" strokeWidth={2} />
            </Button>
          )}
        </div>
      </Card>
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
