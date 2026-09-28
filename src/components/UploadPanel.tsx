'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  UploadCloud,
  FileUp,
  TriangleAlert,
  RotateCcw,
  Sparkles,
  ClipboardPaste,
  FileText,
} from 'lucide-react';
import { Button, Card, Skeleton, Badge } from '@/components/ui';
import { Reveal } from '@/components/Reveal';
import { PlanReview, type Plan } from '@/components/PlanReview';
import { parseDocx, parsePdf, parseTxt } from '@/lib/parser';

interface Finding {
  code: string;
  severity: 'error' | 'warning';
  detail: string;
}

type JobStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'done'
  | 'attention'
  | 'rejected'
  | 'failed'
  | 'interrupted';

/** Mirrors isActive() on the server: a Hermes process is running. */
const ACTIVE: JobStatus[] = ['planning', 'executing'];

/** Mirrors isFinal(): nothing further happens on its own. */
const FINAL: JobStatus[] = ['done', 'attention', 'rejected', 'failed', 'interrupted'];

interface Job {
  id: string;
  status: JobStatus;
  filename: string;
  startedAt?: string;
  revision?: number;
  lines: string[];
  diff: { newPages: number; updatedPages: number; newConnections: number } | null;
  lint: { ok: boolean; findings: Finding[] } | null;
  commit?: string | null;
  error: string | null;
}

type TabMode = 'file' | 'paste';

/**
 * Upload & Paste Panel.
 * Performs client-side pre-parsing (.docx -> mammoth+turndown, .pdf -> pdfjs with OCR guard, .txt/paste -> native text)
 * and submits formatted Markdown directly to /api/upload for saving into raw/.
 */
export function UploadPanel({ cluster }: { cluster: string }) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [parsingMsg, setParsingMsg] = useState<string | null>(null);

  const [tab, setTab] = useState<TabMode>('file');

  // The proposed ingest, once planning finishes. Null while it is being made.
  const [plan, setPlan] = useState<Plan | null>(null);
  const [deciding, setDeciding] = useState(false);

  // Pasted text state
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteContent, setPasteContent] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const storageKey = `ingest:${cluster}`;

  const loadPlan = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/pipeline/plan?jobId=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (res.ok) setPlan(data.plan as Plan);
      else setError(data.error ?? 'Could not load the plan');
    } catch {
      setError('Could not load the plan');
    }
  }, []);

  const attach = useCallback(
    (jobId: string) => {
      const source = new EventSource(`/api/jobs/${jobId}`);

      source.addEventListener('job', (ev) => {
        const next = JSON.parse((ev as MessageEvent).data) as Job;
        setJob(next);

        // The stream ends whenever no agent is running — which now includes the
        // resting state in the middle. Only a genuinely final job is forgotten;
        // a plan waiting for a decision has to survive a refresh, or closing the
        // tab would lose it, which is the one thing the gate must not do.
        if (FINAL.includes(next.status)) {
          localStorage.removeItem(storageKey);
          router.refresh();
        }
        if (!ACTIVE.includes(next.status)) {
          source.close();
        }
        if (next.status === 'awaiting_approval') {
          void loadPlan(next.id);
        } else {
          setPlan(null);
        }
      });

      source.onerror = () => source.close();
      return () => source.close();
    },
    [router, storageKey, loadPlan],
  );

  useEffect(() => {
    const pending = localStorage.getItem(storageKey);
    if (pending) return attach(pending);
  }, [attach, storageKey]);

  /** Approve, Reject and Revise all re-attach: each starts a new agent run or
   *  ends the job, and either way the panel follows the same job id. */
  async function decide(path: string, body: Record<string, unknown>) {
    if (!job) return;
    setDeciding(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipeline/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'That did not work');
      setJob(data.job as Job);
      setPlan(null);
      if (ACTIVE.includes((data.job as Job).status)) {
        localStorage.setItem(storageKey, job.id);
        attach(job.id);
      } else {
        localStorage.removeItem(storageKey);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setDeciding(false);
    }
  }

  async function handleFileSubmit(file: File) {
    setError(null);
    setParsingMsg('Extracting document text...');
    setSending(true);

    try {
      let extractedText = '';
      const nameLower = file.name.toLowerCase();

      if (nameLower.endsWith('.docx')) {
        extractedText = await parseDocx(file);
      } else if (nameLower.endsWith('.pdf')) {
        const res = await parsePdf(file);
        extractedText = res.text;
      } else {
        extractedText = await parseTxt(file);
      }

      if (!extractedText.trim()) {
        throw new Error('No text could be extracted from this document.');
      }

      setParsingMsg('Sending file to server...');

      const body = new FormData();
      body.append('cluster', cluster);
      body.append('parsedText', extractedText);
      body.append('filename', file.name);
      body.append('file', file); // Save original binary in .dashboard/originals/

      const res = await fetch('/api/upload', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');

      localStorage.setItem(storageKey, data.jobId);
      setJob({
        id: data.jobId,
        status: 'planning',
        filename: file.name,
        lines: [],
        diff: null,
        lint: null,
        error: null,
      });
      attach(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File parsing/upload failed');
    } finally {
      setSending(false);
      setParsingMsg(null);
    }
  }

  async function handlePasteSubmit() {
    if (!pasteContent.trim()) {
      setError('Please paste or type text before submitting.');
      return;
    }

    setError(null);
    setSending(true);

    try {
      const filename = pasteTitle.trim()
        ? `${pasteTitle.trim().replace(/[^\w.\- ]+/g, '_')}.md`
        : `pasted_note_${new Date().toISOString().slice(0, 10)}.md`;

      const body = new FormData();
      body.append('cluster', cluster);
      body.append('parsedText', pasteContent.trim());
      body.append('filename', filename);

      const res = await fetch('/api/upload', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Submission failed');

      localStorage.setItem(storageKey, data.jobId);
      setJob({
        id: data.jobId,
        status: 'planning',
        filename,
        lines: [],
        diff: null,
        lint: null,
        error: null,
      });
      attach(data.jobId);
      setPasteTitle('');
      setPasteContent('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSending(false);
    }
  }

  const running = (job !== null && ACTIVE.includes(job.status)) || sending;

  if (job && job.status === 'awaiting_approval' && plan) {
    return (
      <PlanReview
        plan={plan}
        busy={deciding}
        error={error}
        onApprove={() => void decide('execute', {})}
        onReject={() => void decide('reject', {})}
        onRevise={(feedback) => void decide('plan', { feedback })}
      />
    );
  }

  if (job && (job.status === 'done' || job.status === 'attention') && job.diff) {
    return <IngestDiff job={job} onDismiss={() => setJob(null)} />;
  }

  if (job && job.status === 'rejected') {
    return (
      <Reveal>
        <Card className="p-6">
          <Badge tone="neutral">Discarded</Badge>
          <h3 className="mt-3.5 text-h2 font-semibold text-bright">
            {job.filename} was <span className="text-muted font-normal">not filed</span>
          </h3>
          <p className="mt-2 max-w-prose text-small text-medium">
            The document and the plan have been deleted. The wiki was never touched.
          </p>
          <Button variant="ghost" className="mt-5" onClick={() => setJob(null)}>
            Add another
          </Button>
        </Card>
      </Reveal>
    );
  }

  if (job && (job.status === 'failed' || job.status === 'interrupted')) {
    return (
      <Card className="border-error/40 p-6">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-error" strokeWidth={1.75} />
          <div className="flex-1">
            <h3 className="text-bright font-semibold">
              {job.status === 'interrupted' ? 'Ingest interrupted' : 'Ingest failed'}
            </h3>
            <p className="mt-1.5 text-small text-medium">{job.error ?? 'The agent stopped before finishing.'}</p>
            <p className="mt-1.5 text-small text-muted">
              Nothing was half-written — the wiki is under version control.
            </p>
            <Button
              variant="ghost"
              className="mt-4"
              onClick={() => {
                // Forget it here too, not only when the SSE event lands. A job
                // that failed while the tab was shut is read back from disk on
                // the next visit, and dismissing it should mean dismissed.
                try {
                  localStorage.removeItem(storageKey);
                } catch {
                  /* private mode, blocked storage — the card still closes */
                }
                setJob(null);
              }}
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} />
              Try again
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (running) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2.5">
          <Sparkles className="h-4 w-4 text-lavender" strokeWidth={1.75} />
          <span className="text-bright font-medium">
            {parsingMsg ??
              (job?.status === 'executing'
                ? `Filing ${job.filename}`
                : `Reading ${job?.filename ?? 'your content'}`)}
          </span>
          {job?.startedAt && <Elapsed since={job.startedAt} />}
        </div>
        <p className="mt-1.5 text-small text-medium">
          {job?.status === 'executing'
            ? 'Writing the pages you approved, then linking them and updating the index. It reports when it is finished, not as it goes. You can leave this page; it keeps running.'
            : 'The agent is reading the whole document to work out what it contains. Nothing is written to the wiki yet — you get to see the plan first. It reports when it is finished, not as it goes. You can leave this page; it keeps running.'}
        </p>

        <div className="mt-5 space-y-2">
          {job && job.lines.length > 0 ? (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-graphite bg-abyss/80 p-3 shadow-subtle">
              {job.lines.slice(-40).map((line, i) => (
                <p key={i} className="font-mono text-[0.75rem] leading-relaxed text-medium">
                  {line}
                </p>
              ))}
            </div>
          ) : (
            <>
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      {/* Header controls & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-graphite pb-4">
        <div className="flex items-center gap-1 rounded-lg border border-graphite bg-abyss/60 p-1 shadow-subtle">
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === 'file'
                ? 'bg-amethyst text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)]'
                : 'text-medium hover:text-bright hover:bg-white/[0.04]'
            }`}
            onClick={() => {
              setTab('file');
              setError(null);
            }}
          >
            <UploadCloud className="h-3.5 w-3.5" />
            Upload File
          </button>
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === 'paste'
                ? 'bg-amethyst text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)]'
                : 'text-medium hover:text-bright hover:bg-white/[0.04]'
            }`}
            onClick={() => {
              setTab('paste');
              setError(null);
            }}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            Paste Text
          </button>
        </div>

        <span className="text-xs text-muted">You approve a plan before anything is written</span>
      </div>

      {tab === 'file' ? (
        <div
          className={`mt-4 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
            dragging ? 'border-amethyst bg-tag-bg' : 'border-graphite hover:border-graphite/80 bg-surface/50'
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFileSubmit(file);
          }}
        >
          <div className="flex flex-col items-center">
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-graphite bg-surface shadow-subtle">
              <FileText className="h-5 w-5 text-lavender" strokeWidth={1.75} />
            </span>
            <h3 className="text-bright font-semibold text-body">Upload Document</h3>
            <p className="mt-1 max-w-prose text-small text-medium">
              Drop a Word (.docx), PDF (.pdf), or Plain Text (.txt, .md) file here.
            </p>

            <input
              ref={inputRef}
              type="file"
              accept=".docx,.pdf,.txt,.md"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileSubmit(file);
                e.target.value = '';
              }}
            />
            <Button className="mt-5" onClick={() => inputRef.current?.click()}>
              <FileUp className="h-4 w-4" strokeWidth={2} />
              Choose File
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-caption font-medium text-medium">
              Document Title / Reference (Optional):
            </label>
            <input
              type="text"
              placeholder="e.g. Q3 Strategic Plan Notes"
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              className="w-full rounded-lg border border-graphite bg-abyss/80 px-3.5 py-2.5 text-body-sm text-bright placeholder:text-muted/60 focus:border-amethyst focus:ring-1 focus:ring-amethyst focus:outline-none shadow-subtle"
            />
          </div>
          <div>
            <label className="mb-1 block text-caption font-medium text-medium">Content / Text:</label>
            <textarea
              rows={6}
              placeholder="Paste raw text or Markdown here..."
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
              className="w-full rounded-lg border border-graphite bg-abyss/80 p-3 text-body-sm text-bright placeholder:text-muted/60 focus:border-amethyst focus:ring-1 focus:ring-amethyst focus:outline-none shadow-subtle"
            />
          </div>
          <Button onClick={handlePasteSubmit} disabled={!pasteContent.trim()}>
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            Ingest Text
          </Button>
        </div>
      )}

      {error && <p className="mt-3.5 text-small text-error">{error}</p>}
    </Card>
  );
}

/** "working, N min" — the honest running state for an agent that answers in one block. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)} min ${s % 60}s`;
  return (
    <span className="ml-auto font-mono text-caption tabular-nums text-muted" aria-live="off">
      {label}
    </span>
  );
}

function IngestDiff({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
  const diff = job.diff!;
  const findings = job.lint?.findings ?? [];
  const attention = job.status === 'attention';
  const stats = [
    { value: diff.newPages, label: diff.newPages === 1 ? 'new page' : 'new pages' },
    { value: diff.updatedPages, label: diff.updatedPages === 1 ? 'page updated' : 'pages updated' },
    { value: diff.newConnections, label: diff.newConnections === 1 ? 'new connection' : 'new connections' },
  ];

  return (
    <Reveal>
      <Card className="border-graphite p-6 shadow-subtle">
        <Badge tone={attention ? 'danger' : 'success'}>{attention ? 'Needs attention' : 'Filed'}</Badge>
        <h3 className="mt-3.5 text-h2 font-semibold text-bright">
          {attention ? (
            <>{job.filename} was read, but the record is <span className="text-error font-semibold">not in order</span></>
          ) : (
            <>{job.filename} is now <span className="text-lavender font-semibold">part of the wiki</span></>
          )}
        </h3>

        <div className="mt-6 grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl border border-graphite bg-surface shadow-subtle px-4 py-4 text-center">
              <div className="font-mono text-h1 text-bright tabular-nums font-semibold">{stat.value}</div>
              <div className="mt-1 text-caption text-medium">{stat.label}</div>
            </div>
          ))}
        </div>

        {findings.length > 0 ? (
          <ul className="mt-5 space-y-2" aria-label="Checks on what was written">
            {findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-small">
                <TriangleAlert
                  className={`mt-0.5 h-4 w-4 shrink-0 ${f.severity === 'error' ? 'text-error' : 'text-muted'}`}
                  strokeWidth={1.75}
                />
                <span className={f.severity === 'error' ? 'text-bright' : 'text-medium'}>{f.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 max-w-prose text-small text-medium">
            Checked against the disk: the index and the log were updated, every new page is linked,
            and every link points at a page that exists.
          </p>
        )}

        <Button variant="ghost" className="mt-5" onClick={onDismiss}>
          {attention ? 'Add another anyway' : 'Add another'}
        </Button>
      </Card>
    </Reveal>
  );
}

