'use client';

import { useState } from 'react';
import type { ClusterSettings, Filing } from '@/lib/settings';

/**
 * Whether a filing waits for approval, decided per wiki.
 *
 * Off by default: every plan is shown first. A wiki whose rules say to file at
 * once can be set to, and every automatic filing can be undone from the card
 * that reports it.
 */
const CHOICES: { value: Filing; title: string; body: string }[] = [
  { value: 'review', title: 'Every filing waits for approval', body: 'The plan is shown first. Nothing is written until someone says yes.' },
  { value: 'automatic', title: 'File at once', body: 'The plan is carried out as soon as it is made. What was written is reported, and can be undone.' },
];

export function FilingSwitch({ cluster, settings }: { cluster: string; settings: ClusterSettings }) {
  const [current, setCurrent] = useState<Filing>(settings.filing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(filing: Filing) {
    if (filing === current || saving) return;
    const was = current;
    setCurrent(filing);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/clusters/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster, settings: { filing } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'That did not save');
      setCurrent((data.settings as ClusterSettings).filing);
    } catch (err) {
      setCurrent(was);
      setError(err instanceof Error ? err.message : 'That did not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4" role="radiogroup" aria-label="How documents are filed">
      <div className="section-title">Filing</div>
      <div className="mt-2 grid gap-1.5">
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={current === choice.value}
            disabled={saving}
            className={`rounded border p-2.5 text-left ${current === choice.value ? 'border-accent bg-canvas' : 'border-line hover:bg-hover'}`}
            onClick={() => void choose(choice.value)}
          >
            <span className="block text-ui font-semibold text-ink">{choice.title}</span>
            <span className="mt-0.5 block text-small text-muted">{choice.body}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-small text-danger">{error}</p>}
    </div>
  );
}
