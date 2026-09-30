'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, TriangleAlert, RotateCcw, FileText, Send } from 'lucide-react';
import { Button, Card, Skeleton, Badge, INPUT } from '@/components/ui';
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
  | 'interrupted'
  | 'undone';

/** Mirrors isActive() on the server: an agent process is running. */
const ACTIVE: JobStatus[] = ['planning', 'executing'];

/** Mirrors isFinal(): nothing further happens on its own. */
const FINAL: JobStatus[] = ['done', 'attention', 'rejected', 'failed', 'interrupted', 'undone'];

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
  /** The plan was carried out as soon as it was made, because the wiki is set to file at once. */
  automatic?: boolean;
  error: string | null;
}

type TabMode = 'file' | 'paste';

/**
 * Adding a document: a file, or pasted text.
 *
 * The text is taken out of the file in the browser (.docx through mammoth and
 * turndown, .pdf through pdfjs, .txt and .md as they are) and sent to
 * /api/upload as Markdown. What follows is the plan, the decision, and the
 * filing, each shown in this same place.
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
    setParsingMsg('Taking the text out of the document');
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
        throw new Error('No text could be taken out of this document.');
      }

      setParsingMsg('Sending it to the server');

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
      setError(err instanceof Error ? err.message : 'The document could not be read or sent');
    } finally {
      setSending(false);
      setParsingMsg(null);
    }
  }

  async function handlePasteSubmit() {
    if (!pasteContent.trim()) {
      setError('Paste or type some text first.');
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
    return <IngestDiff job={job} busy={deciding} error={error} onUndo={() => void decide('undo', {})} onDismiss={() => setJob(null)} />;
  }

  if (job && job.status === 'undone') {
    return (
      <Card className="p-4">
        <Badge tone="neutral">Undone</Badge>
        <h3 className="mt-2.5 text-title font-semibold text-ink">{job.filename} was taken back out</h3>
        <p className="mt-1 max-w-prose text-body text-muted">
          The pages it wrote and the source it filed were reverted in a commit of their own. The wiki is as it was before.
        </p>
        <Button variant="ghost" className="mt-4" onClick={() => setJob(null)}>
          Add another
        </Button>
      </Card>
    );
  }

  if (job && job.status === 'rejected') {
    return (
      <Card className="p-4">
        <Badge tone="neutral">Discarded</Badge>
        <h3 className="mt-2.5 text-title font-semibold text-ink">{job.filename} was not filed</h3>
        <p className="mt-1 max-w-prose text-body text-muted">
          The document and the plan have been deleted. The wiki was never touched.
        </p>
        <Button variant="ghost" className="mt-4" onClick={() => setJob(null)}>
          Add another
        </Button>
      </Card>
    );
  }

  if (job && (job.status === 'failed' || job.status === 'interrupted')) {
    return (
      <Card className="border-danger/50 p-4">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 flex-none text-danger" size={17} />
          <div className="min-w-0 flex-1">
            <h3 className="text-body font-semibold text-ink">
              {job.status === 'interrupted' ? 'Filing was interrupted' : 'Filing failed'}
            </h3>
            <p role="alert" className="mt-1 text-body text-muted">
              {job.error ?? 'The agent stopped before finishing.'}
            </p>
            <p className="mt-1 text-ui text-muted">
              The wiki is under version control, so a half-written filing can be undone.
            </p>
            <Button
              variant="ghost"
              className="mt-3"
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
              <RotateCcw size={15} />
              Try again
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (running) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-accent" aria-hidden />
          <span className="text-body font-semibold text-ink">
            {parsingMsg ??
              (job?.status === 'executing'
                ? `Filing ${job.filename}`
                : `Reading ${job?.filename ?? 'your text'}`)}
          </span>
          {job?.startedAt && <Elapsed since={job.startedAt} />}
        </div>
        <p className="mt-1 max-w-prose text-ui text-muted">
          {job?.status === 'executing'
            ? 'Writing the pages you approved, then linking them and updating the index. You can leave this page. It keeps running.'
            : 'The agent is reading the whole document to work out what it contains. Nothing is written to the wiki yet. You see the plan first. You can leave this page. It keeps running.'}
        </p>

        <div className="mt-3 space-y-2">
          {job && job.lines.length > 0 ? (
            <div className="max-h-44 overflow-y-auto rounded border border-line bg-canvas px-2.5 py-2">
              {job.lines.slice(-40).map((line, i) => (
                <p key={i} className="font-mono text-small text-muted">
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
    <Card>
      <div className="sidebar-header tabs">
        <button
          type="button"
          className={`panel-tab${tab === 'file' ? ' active' : ''}`}
          onClick={() => {
            setTab('file');
            setError(null);
          }}
        >
          Upload a file
        </button>
        <button
          type="button"
          className={`panel-tab${tab === 'paste' ? ' active' : ''}`}
          onClick={() => {
            setTab('paste');
            setError(null);
          }}
        >
          Paste text
        </button>
        <span className="statusbar-spacer" />
        <span className="hidden text-small text-muted sm:inline">You approve a plan before anything is written</span>
      </div>

      <div className="p-4">
        {tab === 'file' ? (
          <div
            className={`rounded border border-dashed px-6 py-7 text-center ${
              dragging ? 'border-accent bg-accent/10' : 'border-line'
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
            <FileText className="mx-auto text-faint" size={22} />
            <h3 className="mt-2 text-body font-semibold text-ink">Add a document</h3>
            <p className="mt-0.5 text-ui text-muted">
              Drop a Word (.docx), PDF (.pdf) or plain text (.txt, .md) file here.
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
            <Button className="mt-4" onClick={() => inputRef.current?.click()}>
              <FileUp size={15} />
              Choose a file
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-ui font-medium text-ink" htmlFor="paste-title">
                Title <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                id="paste-title"
                type="text"
                placeholder="e.g. Q3 planning notes"
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label className="mb-1 block text-ui font-medium text-ink" htmlFor="paste-text">
                Text
              </label>
              <textarea
                id="paste-text"
                rows={6}
                placeholder="Paste text or Markdown here"
                value={pasteContent}
                onChange={(e) => setPasteContent(e.target.value)}
                className={INPUT}
              />
            </div>
            <Button onClick={handlePasteSubmit} disabled={!pasteContent.trim()}>
              <Send size={15} />
              Read this text
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-ui text-danger">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}

/** How long the agent has been at it. It answers in one block, so this is the only sign of life there is. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)} min ${s % 60}s`;
  return (
    <span className="ml-auto font-mono text-small tabular-nums text-muted" aria-live="off">
      {label}
    </span>
  );
}

function IngestDiff({
  job,
  busy,
  error,
  onUndo,
  onDismiss,
}: {
  job: Job;
  busy: boolean;
  error: string | null;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const diff = job.diff!;
  const findings = job.lint?.findings ?? [];
  const attention = job.status === 'attention';
  const stats = [
    { value: diff.newPages, label: diff.newPages === 1 ? 'new page' : 'new pages' },
    { value: diff.updatedPages, label: diff.updatedPages === 1 ? 'page updated' : 'pages updated' },
    { value: diff.newConnections, label: diff.newConnections === 1 ? 'new connection' : 'new connections' },
  ];

  return (
    <Card className={attention ? 'border-danger/50 p-4' : 'p-4'}>
      <Badge tone={attention ? 'danger' : 'success'}>{attention ? 'Needs attention' : 'Filed'}</Badge>
      <h3 className="mt-2.5 text-title font-semibold text-ink">
        {attention
          ? `${job.filename} was read, but the record is not in order`
          : `${job.filename} is now part of the wiki`}
      </h3>
      {job.automatic && (
        <p className="mt-1 max-w-prose text-ui text-muted">
          Filed at once, as this cluster is set to. Undo it below if the plan was not what you would have approved.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-3 divide-x divide-line rounded border border-line bg-canvas text-center">
        {stats.map((stat) => (
          <div key={stat.label} className="px-3 py-3">
            <dd className="text-display font-semibold tabular-nums text-ink">{stat.value}</dd>
            <dt className="text-small text-muted">{stat.label}</dt>
          </div>
        ))}
      </dl>

      {findings.length > 0 ? (
        <ul className="mt-4 space-y-1.5" aria-label="Checks on what was written">
          {findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-ui">
              <TriangleAlert
                className={`mt-0.5 flex-none ${f.severity === 'error' ? 'text-danger' : 'text-warning'}`}
                size={15}
              />
              <span className={f.severity === 'error' ? 'text-ink' : 'text-muted'}>{f.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 max-w-prose text-ui text-muted">
          Checked against the disk: the index and the log were updated, every new page is linked, and
          every link points at a page that exists.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-small text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onDismiss} disabled={busy}>
          {attention ? 'Add another anyway' : 'Add another'}
        </Button>
        {job.commit && (
          <Button variant="quiet" onClick={onUndo} disabled={busy} title="Take this filing back out of the wiki">
            <RotateCcw size={14} />
            {busy ? 'Undoing…' : 'Undo this filing'}
          </Button>
        )}
      </div>
    </Card>
  );
}
