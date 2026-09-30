import { Suspense } from 'react';
import { secondFactorOn } from '@/lib/env-auth';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

/** Rendered on the server so that the form knows whether to ask for a code. */
export default function LoginPage() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-canvas px-4 py-12">
      <Suspense fallback={<p className="text-ui text-muted">Loading…</p>}>
        <LoginForm needsCode={secondFactorOn()} />
      </Suspense>
    </main>
  );
}
