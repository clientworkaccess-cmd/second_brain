'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Center } from '@/components/frame/Frame';
import { Button, ButtonLink, Card, Field, Input, Textarea } from '@/components/ui';

/**
 * Cluster creation is an interview, not a mkdir.
 *
 * The answers become SCHEMA.md — the highest-leverage file in the system, and
 * the thing that makes Operations behave differently from Finance. Asking four
 * real questions here is what stops every cluster curating identically.
 */

const STEPS = [
  {
    key: 'scope' as const,
    question: 'What does this area of the business cover?',
    hint: 'Plain sentences. This becomes the rule the agent uses to decide what belongs here and what does not.',
    placeholder:
      'How we fulfil and return customer orders — warehouse process, shipping partners, refund and exchange policy. Not pricing, not marketing.',
    required: true,
  },
  {
    key: 'entities' as const,
    question: 'Who and what comes up in it?',
    hint: 'People, teams, systems, vendors, products. The agent will make a page for each and link them together.',
    placeholder: 'Warehouse Team, Returns Portal, DHL, Stripe, Customer Support',
    required: false,
  },
  {
    key: 'questions' as const,
    question: 'What would you want to ask it later?',
    hint: 'A few real questions. These tell the agent what to make sure it captures.',
    placeholder:
      'How do we handle a refund past 30 days?\nWho approves an exchange over £500?\nWhich courier do we use for oversized items?',
    required: false,
  },
];

export default function NewCluster() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [answers, setAnswers] = useState({ scope: '', entities: '', questions: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = useMemo(
    () => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    [name],
  );

  const onName = step === 0;
  const current = STEPS[Math.max(0, step - 1)];
  const total = STEPS.length + 1;

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
        body: JSON.stringify({ name: slug, ...answers }),
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
                One area of the business. Start with a single cluster. Merging two later is cheap,
                splitting one is not.
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
