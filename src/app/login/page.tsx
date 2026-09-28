'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Network, Lock, Mail, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';
import { Button, Card, Field, Input } from '@/components/ui';
import { returnPath } from '@/lib/gate';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = returnPath(searchParams.get('from'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Invalid email or password');
        setLoading(false);
        return;
      }

      router.push(from);
      router.refresh();
    } catch {
      setError('Connection failed. Please check your network.');
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md p-8 sm:p-10 shadow-lift border-line bg-elevated/90 backdrop-blur-md">
      <div className="text-center">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 border border-accent/20 mb-4 text-accent">
          <Network className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h1 className="text-h1 text-ink">
          Knowledge <span className="font-serif italic text-accent">Graph</span>
        </h1>
        <p className="mt-2 text-small text-muted">
          Sign in with your authorized credentials to continue
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        {error && (
          <div className="flex items-center gap-2.5 rounded border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-small text-danger">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Field label="Email address">
          <div className="relative">
            <Mail className="absolute left-3.5 top-3 h-4 w-4 text-muted/60" />
            <Input
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10"
            />
          </div>
        </Field>

        <Field label="Password">
          <div className="relative">
            <Lock className="absolute left-3.5 top-3 h-4 w-4 text-muted/60" />
            <Input
              type="password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10"
            />
          </div>
        </Field>

        <div className="pt-2">
          <Button
            type="submit"
            variant="primary"
            disabled={loading}
            className="w-full py-3 text-body font-semibold justify-center"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              <>
                Sign in
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-base px-4 py-12">
      <Suspense
        fallback={
          <div className="text-small text-muted flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
