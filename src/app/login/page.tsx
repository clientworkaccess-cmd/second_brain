import { Suspense } from 'react';
import { AUTH_CAPTCHA } from '@/lib/env-auth';
import { methodsOffered } from '@/lib/signin';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

/** Rendered on the server so that the form knows whether to show the captcha, and whether a forgotten password can be reset from here (it needs a way to send a code). What follows the password it learns after it. */
export default function LoginPage() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-canvas px-4 py-12">
      <Suspense fallback={<p className="text-ui text-muted">Loading…</p>}>
        <LoginForm captcha={AUTH_CAPTCHA} reset={methodsOffered().length > 0} />
      </Suspense>
    </main>
  );
}
