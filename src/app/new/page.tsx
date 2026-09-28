'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { TopBar } from '@/components/TopBar';
import { Reveal } from '@/components/Reveal';
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the cluster');
      setSaving(false);
    }
  }

  return (
    <div className="min-h-[100dvh]">
      <TopBar>
        <ButtonLink href="/" variant="quiet">
          <ArrowLeft className="h-4 w-4" strokeWidth={2} />
          Cancel
        </ButtonLink>
      </TopBar>

      <main className="mx-auto max-w-2xl px-6 py-16">
        <div className="mb-8 flex items-center gap-2" aria-hidden>
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                i <= step ? 'bg-accent' : 'bg-white/10'
              }`}
            />
          ))}
        </div>

        <Reveal key={step}>
          <Card className="p-7">
            {onName ? (
              <>
                <h1 className="text-h1 text-ink">What should we call it?</h1>
                <p className="mt-2 max-w-prose text-body">
                  One area of the business. Start with a single cluster — merging two later is
                  cheap, splitting one is not.
                </p>
                <div className="mt-7">
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
                    <p className="mt-2.5 font-mono text-small text-muted/70">
                      /var/llm_wiki/<span className="text-accent">{slug}</span>
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <h1 className="text-h1 text-ink">{current.question}</h1>
                <p className="mt-2 max-w-prose text-body">{current.hint}</p>
                <div className="mt-7">
                  <Field label={current.required ? 'Required' : 'Optional — you can add this later'}>
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

            {error && <p className="mt-4 text-small text-danger">{error}</p>}

            <div className="mt-8 flex items-center justify-between">
              <Button
                variant="quiet"
                onClick={() => setStep((s) => s - 1)}
                disabled={step === 0 || saving}
              >
                <ArrowLeft className="h-4 w-4" strokeWidth={2} />
                Back
              </Button>

              {step < total - 1 ? (
                <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
                  Continue
                  <ArrowRight className="h-4 w-4" strokeWidth={2} />
                </Button>
              ) : (
                <Button onClick={submit} disabled={saving || !canAdvance}>
                  <Check className="h-4 w-4" strokeWidth={2} />
                  {saving ? 'Creating…' : 'Create cluster'}
                </Button>
              )}
            </div>
          </Card>
        </Reveal>
      </main>
    </div>
  );
}
