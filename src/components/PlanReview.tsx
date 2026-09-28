'use client';

import { useState } from 'react';
import { Check, X, PencilLine, Quote, CornerDownRight, EyeOff } from 'lucide-react';
import { Button, Card, Badge } from '@/components/ui';
import { Reveal } from '@/components/Reveal';

/**
 * The human gate.
 *
 * Deliberately written in the founder's language: people, decisions and
 * connections, never folders or filenames. Approving is meant to be a
 * judgement about whether the document was understood — a list of file paths
 * asks a question the reader cannot answer, and the paths are derived in
 * lib/plans.ts anyway, so the agent never proposed one.
 *
 * Every claim expands to the sentence it came from. That is the whole
 * verification story: you are checking quotes, not trusting a summary.
 */

export interface PlanPage {
  kind: 'entity' | 'concept' | 'comparison' | 'query';
  name: string;
  summary: string;
  quote: string;
  existing: boolean;
}

export interface Plan {
  jobId: string;
  filename: string;
  revision: number;
  feedback: string | null;
  pages: PlanPage[];
  decisions: { statement: string; by: string | null; quote: string }[];
  links: { from: string; to: string; why: string }[];
  skipped: { what: string; why: string }[];
}

const KIND_LABEL: Record<PlanPage['kind'], string> = {
  entity: 'person or thing',
  concept: 'idea or process',
  comparison: 'comparison',
  query: 'recurring question',
};

export function PlanReview({
  plan,
  busy,
  error,
  onApprove,
  onReject,
  onRevise,
}: {
  plan: Plan;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  onRevise: (feedback: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');

  const created = plan.pages.filter((p) => !p.existing);
  const updated = plan.pages.filter((p) => p.existing);

  return (
    <Reveal>
      <Card className="border-graphite p-6 shadow-subtle">
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge tone="accent">Proposed — nothing written yet</Badge>
          {plan.revision > 1 && <span className="text-xs text-muted">plan {plan.revision}</span>}
        </div>

        <h3 className="mt-3.5 text-h2 font-semibold text-bright">
          What I found in <span className="text-lavender">{plan.filename}</span>
        </h3>

        <p className="mt-2 max-w-prose text-body-sm text-medium">
          Nothing has been added to the wiki. Check that this matches the document, then decide.
        </p>

        {plan.feedback && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-graphite bg-abyss/60 p-3 text-body-sm text-medium shadow-subtle">
            <CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-lavender" strokeWidth={1.75} />
            <span>
              Revised after you said: <span className="text-bright font-medium">{plan.feedback}</span>
            </span>
          </p>
        )}

        {created.length > 0 && (
          <Section title="New to the wiki">
            {created.map((p, i) => (
              <Item key={i} title={p.name} note={KIND_LABEL[p.kind]} body={p.summary} quote={p.quote} />
            ))}
          </Section>
        )}

        {updated.length > 0 && (
          <Section title="Already known — learned something new">
            {updated.map((p, i) => (
              <Item key={i} title={p.name} note={KIND_LABEL[p.kind]} body={p.summary} quote={p.quote} />
            ))}
          </Section>
        )}

        {plan.decisions.length > 0 && (
          <Section title="Decisions made">
            {plan.decisions.map((d, i) => (
              <Item
                key={i}
                title={d.statement}
                note={d.by ? `decided by ${d.by}` : null}
                body={null}
                quote={d.quote}
              />
            ))}
          </Section>
        )}

        {plan.links.length > 0 && (
          <Section title="How these connect">
            {plan.links.map((l, i) => (
              <li key={i} className="text-body-sm text-medium">
                <span className="text-bright font-medium">{l.from}</span> → <span className="text-bright font-medium">{l.to}</span>
                <span className="text-muted"> — {l.why}</span>
              </li>
            ))}
          </Section>
        )}

        {plan.skipped.length > 0 && (
          <Section title="Deliberately left out" icon={<EyeOff className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />}>
            {plan.skipped.map((s, i) => (
              <li key={i} className="text-body-sm text-medium">
                <span className="text-bright font-medium">{s.what}</span>
                <span className="text-muted"> — {s.why}</span>
              </li>
            ))}
          </Section>
        )}

        {error && <p className="mt-4 text-small text-error">{error}</p>}

        {revising ? (
          <div className="mt-6 space-y-3">
            <label className="block text-caption font-medium text-medium">
              What should be different?
            </label>
            <textarea
              rows={3}
              autoFocus
              placeholder="e.g. Don't create a page for Stripe — fold it into Payment Gateway."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="w-full rounded-lg border border-graphite bg-abyss/80 p-3 text-body-sm text-bright placeholder:text-muted/60 focus:border-amethyst focus:ring-1 focus:ring-amethyst focus:outline-none shadow-subtle"
            />
            <div className="flex flex-wrap gap-2.5">
              <Button disabled={!feedback.trim() || busy} onClick={() => onRevise(feedback.trim())}>
                <PencilLine className="h-4 w-4" strokeWidth={2} />
                Send it back
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRevising(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button disabled={busy} onClick={onApprove}>
              <Check className="h-4 w-4" strokeWidth={2} />
              Approve &amp; file
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setRevising(true)}>
              <PencilLine className="h-4 w-4" strokeWidth={2} />
              Revise
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onReject}>
              <X className="h-4 w-4" strokeWidth={2} />
              Discard
            </Button>
          </div>
        )}
      </Card>
    </Reveal>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6">
      <h4 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-muted">
        {icon}
        {title}
      </h4>
      <ul className="mt-2.5 space-y-2.5">{children}</ul>
    </div>
  );
}

/** One claim, with the sentence it came from a click away. */
function Item({
  title,
  note,
  body,
  quote,
}: {
  title: string;
  note: string | null;
  body: string | null;
  quote: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-body-sm font-medium text-bright">{title}</span>
        {note && <span className="text-caption text-muted">{note}</span>}
        {quote && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto flex items-center gap-1 text-caption text-muted transition-colors hover:text-lavender"
          >
            <Quote className="h-3 w-3" strokeWidth={2} />
            {open ? 'hide source' : 'source'}
          </button>
        )}
      </div>
      {body && <p className="mt-0.5 text-body-sm text-medium">{body}</p>}
      {open && quote && (
        <p className="mt-1.5 border-l-2 border-amethyst pl-3 text-body-sm italic text-medium">
          “{quote}”
        </p>
      )}
    </li>
  );
}
