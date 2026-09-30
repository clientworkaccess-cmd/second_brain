'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mark } from '@/components/Logo';
import { Button, Field, Input } from '@/components/ui';
import { returnPath } from '@/lib/gate';

/** The sign-in form. `needsCode` is whether the server asks for a second factor. */
export function LoginForm({ needsCode }: { needsCode: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = returnPath(searchParams.get('from'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(needsCode ? { email, password, code } : { email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || (needsCode ? 'Invalid email, password or code' : 'Invalid email or password'));
        setCode('');
        setLoading(false);
        return;
      }

      router.push(from);
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection.');
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-[340px]">
      <div className="flex flex-col items-center text-center">
        <Mark size={52} />
        <h1 className="mt-4 text-display font-bold text-ink">Second Brain</h1>
        <p className="mt-1 text-body text-muted">Sign in to continue</p>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-3.5 rounded border border-line bg-panel p-5">
        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-ui text-danger">
            {error}
          </p>
        )}

        <Field label="Email address">
          <Input
            type="email"
            required
            autoFocus
            autoComplete="username"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Password">
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {needsCode && (
          <Field label="Code from your authenticator app">
            <Input
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              placeholder="123 456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}

        <Button type="submit" disabled={loading} className="w-full">
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
