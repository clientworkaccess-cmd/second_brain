'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Center } from '@/components/frame/Frame';
import { Button, ButtonLink, Card, Field, Input, Textarea } from '@/components/ui';

/**
 * Making a wiki is an interview, not a mkdir.
 *
 * The answers become the rules file — the highest-leverage file in the system,
 * and the thing that makes Operations behave differently from Finance. Asking
 * a few real questions here is what stops every wiki curating identically.
 *
 * Two layouts (see lib/layout.ts): a cluster for one area of a business, with
 * SCHEMA.md; or a brain for a group of businesses, with CLAUDE.md, where every
 * page says which business it concerns and what kind of work it is about.
 */

type LayoutChoice = 'cluster' | 'brain';
type Answers = { scope: string; entities: string; businesses: string; questions: string };

interface Step {
  key: keyof Answers;
  question: string;
  hint: string;
  placeholder: string;
  required: boolean;
}

const SCOPE_OF_CLUSTER: Step = {
  key: 'scope',
  question: 'What does this area of the business cover?',
  hint: 'Plain sentences. This becomes the rule the agent uses to decide what belongs here and what does not.',
  placeholder:
    'How we fulfil and return customer orders — warehouse process, shipping partners, refund and exchange policy. Not pricing, not marketing.',
  required: true,
};

const QUESTIONS: Step = {
  key: 'questions',
  question: 'What would you want to ask it later?',
  hint: 'A few real questions. These tell the agent what to make sure it captures.',
  placeholder:
    'How do we handle a refund past 30 days?\nWho approves an exchange over £500?\nWhich courier do we use for oversized items?',
  required: false,
};

const STEPS: Record<LayoutChoice, Step[]> = {
  cluster: [
    SCOPE_OF_CLUSTER,
    {
      key: 'entities',
      question: 'Who and what comes up in it?',
      hint: 'People, teams, systems, vendors, products. The agent will make a page for each and link them together.',
      placeholder: 'Warehouse Team, Returns Portal, DHL, Stripe, Customer Support',
      required: false,
    },
    QUESTIONS,
  ],
  brain: [
    {
      key: 'scope',
      question: 'What is this group of businesses?',
      hint: 'Plain sentences. This opens the rules file and the overview page.',
      placeholder: 'The Northwind group: a holding company, three bakery shops with a wholesale round, a bicycle repair and hire shop, and a print shop bought in 2025.',
      required: true,
    },
    {
      key: 'businesses',
      question: 'Which businesses?',
      hint: 'One per line. Every page will say which of these it concerns, and the agent may not invent one. A short name for the value is made from the name, or write it yourself: "harbour-bakery: Harbour Bakery".',
      placeholder: 'Northwind Holdings\nHarbour Bakery\nCedar Cycles\nlumen-print: Lumen Print',
      required: true,
    },
    QUESTIONS,
  ],
};

const LAYOUTS: { id: LayoutChoice; title: string; body: string }[] = [
  { id: 'cluster', title: 'One area of a business', body: 'Pages for the people, things and ideas in it. Simple, and enough for most teams.' },
  { id: 'brain', title: 'A group of businesses', body: 'Every page says which business it concerns and what kind of work it is about, so the same wiki can be read by business or by department.' },
];

export default function NewCluster() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [layout, setLayout] = useState<LayoutChoice>('cluster');
  const [answers, setAnswers] = useState<Answers>({ scope: '', entities: '', businesses: '', questions: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = useMemo(
    () => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    [name],
  );

  const steps = STEPS[layout];
  const onName = step === 0;
  const current = steps[Math.max(0, step - 1)];
  const total = steps.length + 1;

  const canAdvance = onName
    ? slug.length > 0
    : !current.required || answers[current.key].trim().length > 0;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, layout, ...answers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not create the cluster');
      router.push(`/c/${slug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the cluster');
      setSaving(false);
    }
  }

  return (
    <Center tab={{ href: '/new', title: 'New cluster' }}>
      <div className="content">
        <div className="mb-4 flex items-center gap-3">
          <span className="section-title">
            Step {step + 1} of {total}
          </span>
          <span className="flex flex-1 items-center gap-1.5" aria-hidden>
            {Array.from({ length: total }).map((_, i) => (
              <span key={i} className={`h-0.5 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-raised'}`} />
            ))}
          </span>
          <ButtonLink href="/" variant="quiet">
            Cancel
          </ButtonLink>
        </div>

        <Card className="p-5">
          {onName ? (
            <>
              <h1 className="text-title font-semibold text-ink">What should we call it?</h1>
              <p className="mt-1 max-w-prose text-body text-muted">
                Start with a single cluster. Merging two later is cheap, splitting one is not.
              </p>
              <div className="mt-5">
                <Field
                  label="Cluster name"
                  hint="Lowercase letters, numbers and dashes. This becomes the folder on disk."
                >
                  <Input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Operations"
                    onKeyDown={(e) => e.key === 'Enter' && canAdvance && setStep(1)}
                  />
                </Field>
                {slug && (
                  <p className="mt-2 font-mono text-small text-muted">
                    /var/brain-data/<span className="text-accent">{slug}</span>
                  </p>
                )}
              </div>
              <div className="mt-5">
                <Field label="What is it about?">
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Layout">
                    {LAYOUTS.map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        role="radio"
                        aria-checked={layout === choice.id}
                        className={`rounded border p-3 text-left ${layout === choice.id ? 'border-accent bg-panel' : 'border-line hover:bg-hover'}`}
                        onClick={() => setLayout(choice.id)}
                      >
                        <span className="block text-body font-semibold text-ink">{choice.title}</span>
                        <span className="mt-1 block text-ui text-muted">{choice.body}</span>
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-title font-semibold text-ink">{current.question}</h1>
              <p className="mt-1 max-w-prose text-body text-muted">{current.hint}</p>
              <div className="mt-5">
                <Field label={current.required ? 'Required' : 'Optional. You can add this later'}>
                  <Textarea
                    autoFocus
                    rows={6}
                    value={answers[current.key]}
                    onChange={(e) => setAnswers({ ...answers, [current.key]: e.target.value })}
                    placeholder={current.placeholder}
                  />
                </Field>
              </div>
            </>
          )}

          {error && <p className="mt-3 text-small text-danger">{error}</p>}

          <div className="mt-6 flex items-center justify-between">
            <Button variant="quiet" onClick={() => setStep((s) => s - 1)} disabled={step === 0 || saving}>
              <ArrowLeft size={15} />
              Back
            </Button>

            {step < total - 1 ? (
              <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
                Continue
                <ArrowRight size={15} />
              </Button>
            ) : (
              <Button onClick={submit} disabled={saving || !canAdvance}>
                <Check size={15} />
                {saving ? 'Creating…' : 'Create cluster'}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </Center>
  );
}
