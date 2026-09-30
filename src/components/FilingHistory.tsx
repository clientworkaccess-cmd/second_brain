'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui';

/**
 * Every filing of a wiki, newest first, with what became of it. A filing that
 * is in the wiki can be taken back out from here; one that is waiting for a
 * decision can be picked up again, in this browser, from the front page.
 */

export interface PastFiling {
  id: string;
  filename: string;
  status: string;
  startedAt: string;
  diff: { newPages: number; updatedPages: number; newConnections: number } | null;
  commit: string | null;
  automatic: boolean;
  findings: number;
  error: string | null;
}

const SAID: Record<string, { label: string; tone: 'neutral' | 'success' | 'danger' | 'accent' }> = {
  planning: { label: 'Reading', tone: 'accent' },
  executing: { label: 'Filing', tone: 'accent' },
  awaiting_approval: { label: 'Waiting for a decision', tone: 'accent' },
  done: { label: 'Filed', tone: 'success' },
  attention: { label: 'Needs attention', tone: 'danger' },
  rejected: { label: 'Discarded', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  interrupted: { label: 'Interrupted', tone: 'danger' },
  undone: { label: 'Undone', tone: 'neutral' },
};

export function FilingHistory({ cluster, filings }: { cluster: string; filings: PastFiling[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function undo(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch('/api/pipeline/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'That did not work');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  /** A plan waiting in another browser: pick it up in this one. */
  function pickUp(id: string) {
    try {
      localStorage.setItem(`ingest:${cluster}`, id);
    } catch {
      /* then the front page will not know it */
    }
    router.push(`/c/${cluster}`);
    router.refresh();
  }

  if (filings.length === 0) return <div className="muted pad">Nothing has been filed here yet.</div>;

  return (
    <div className="backlinks">
      {error && (
        <p role="alert" className="px-3 py-1 text-small text-danger">
          {error}
        </p>
      )}
      {filings.map((filing) => {
        const said = SAID[filing.status] ?? { label: filing.status, tone: 'neutral' as const };
        const numbers = filing.diff
          ? `${filing.diff.newPages} new · ${filing.diff.updatedPages} updated${filing.findings ? ` · ${filing.findings} to look at` : ''}`
          : filing.error ?? '';
        return (
          <div key={filing.id} className="backlink-group">
            <div className="flex items-baseline gap-2 px-1.5">
              <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={filing.filename}>
                {filing.filename}
              </span>
              <span className="flex-none text-tiny text-faint">{filing.startedAt.slice(0, 10)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-1.5 pt-1">
              <Badge tone={said.tone}>{said.label}</Badge>
              {filing.automatic && <span className="text-tiny text-faint">at once</span>}
              {numbers && <span className="min-w-0 truncate text-small text-muted">{numbers}</span>}
            </div>
            {(filing.status === 'done' || filing.status === 'attention') && filing.commit && (
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 px-1.5 text-small text-muted hover:text-ink disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void undo(filing.id)}
                title="Take this filing back out of the wiki"
              >
                <RotateCcw size={12} />
                {busy === filing.id ? 'Undoing…' : 'Undo'}
              </button>
            )}
            {filing.status === 'awaiting_approval' && (
              <button
                type="button"
                className="mt-1 px-1.5 text-small text-link hover:underline"
                onClick={() => pickUp(filing.id)}
              >
                Decide
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
