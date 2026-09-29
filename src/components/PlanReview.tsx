'use client';

import { useState } from 'react';
import { Check, X, PencilLine, Quote, CornerDownRight } from 'lucide-react';
import { Button, Card, Badge, INPUT, SectionTitle } from '@/components/ui';

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
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">Proposed. Nothing written yet</Badge>
        {plan.revision > 1 && <span className="text-small text-muted">plan {plan.revision}</span>}
      </div>

      <h3 className="mt-2.5 text-title font-semibold text-ink">
        What I found in <span className="text-accent">{plan.filename}</span>
      </h3>

      <p className="mt-1 max-w-prose text-body text-muted">
        Nothing has been added to the wiki. Check that this matches the document, then decide.
      </p>

      {plan.feedback && (
        <p className="mt-3 flex items-start gap-2 rounded border border-line bg-canvas px-2.5 py-2 text-body text-muted">
          <CornerDownRight className="mt-0.5 flex-none text-accent" size={15} />
          <span>
            Revised after you said: <span className="font-medium text-ink">{plan.feedback}</span>
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
        <Section title="Already known, and something new about it">
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
            <li key={i} className="text-body text-muted">
              <span className="font-medium text-ink">{l.from}</span> → <span className="font-medium text-ink">{l.to}</span>
              <span> · {l.why}</span>
            </li>
          ))}
        </Section>
      )}

      {plan.skipped.length > 0 && (
        <Section title="Deliberately left out">
          {plan.skipped.map((s, i) => (
            <li key={i} className="text-body text-muted">
              <span className="font-medium text-ink">{s.what}</span>
              <span> · {s.why}</span>
            </li>
          ))}
        </Section>
      )}

      {error && (
        <p role="alert" className="mt-4 text-ui text-danger">
          {error}
        </p>
      )}

      {revising ? (
        <div className="mt-5 space-y-2.5">
          <label className="block text-ui font-medium text-ink" htmlFor="plan-feedback">
            What should be different?
          </label>
          <textarea
            id="plan-feedback"
            rows={3}
            autoFocus
            placeholder="e.g. Don't create a page for Stripe. Fold it into Payment Gateway."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            className={INPUT}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={!feedback.trim() || busy} onClick={() => onRevise(feedback.trim())}>
              <PencilLine size={15} />
              Send it back
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setRevising(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={onApprove}>
            <Check size={15} />
            Approve &amp; file
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setRevising(true)}>
            <PencilLine size={15} />
            Revise
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onReject}>
            <X size={15} />
            Discard
          </Button>
        </div>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <SectionTitle>{title}</SectionTitle>
      <ul className="mt-2 space-y-2">{children}</ul>
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
        <span className="text-body font-medium text-ink">{title}</span>
        {note && <span className="text-small text-muted">{note}</span>}
        {quote && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto flex items-center gap-1 text-small text-muted hover:text-link"
          >
            <Quote size={12} />
            {open ? 'hide source' : 'source'}
          </button>
        )}
      </div>
      {body && <p className="text-body text-muted">{body}</p>}
      {open && quote && (
        <p className="mt-1.5 border-l-[3px] border-accent pl-3 text-body text-muted">“{quote}”</p>
      )}
    </li>
  );
}
