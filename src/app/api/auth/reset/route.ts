import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { isSignInEmail, recordFailure, retryAfter } from '@/lib/auth';
import { captchaOn, verifyCaptcha } from '@/lib/captcha';
import { authConfigured } from '@/lib/env-auth';
import { methodsOffered, openSignIn } from '@/lib/signin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A forgotten password: the captcha and the sign-in address get a reset
 * ticket and the ways a code can reach the person. The code goes out through
 * /api/auth/code like a sign-in code, and /api/auth/reset/complete takes the
 * code with the new password.
 *
 * There is nothing to reset with when no email, text or authenticator is set
 * up: then the password is reset on the server, with `npm run hash-password`.
 */
export async function POST(request: Request) {
  if (!authConfigured()) return NextResponse.json({ error: 'Sign-in is not set up on this server yet' }, { status: 503 });

  const client = clientOf(request);
  const wait = retryAfter(client);
  if (wait > 0) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }

  let email: unknown;
  let captcha: unknown;
  try {
    ({ email, captcha } = (await request.json()) ?? {});
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  if (captchaOn() && !(await verifyCaptcha(captcha))) {
    return NextResponse.json({ error: 'Please complete the check and try again' }, { status: 400 });
  }

  const methods = methodsOffered();
  if (methods.length === 0) {
    return NextResponse.json({ error: 'No way to send a code is set up on this server. The password is reset on the server itself.' }, { status: 400 });
  }

  // One login, so there is one address it can be. A wrong one counts like a
  // wrong password: the throttle is what keeps this from being a way to flood
  // the owner's inbox.
  if (!isSignInEmail(email)) {
    recordFailure(client);
    await audit({ event: 'sign-in-refused', client, detail: 'reset asked for another address' });
    return NextResponse.json({ error: 'That is not the sign-in address' }, { status: 401 });
  }

  const { ticket } = openSignIn(client, Date.now(), 'reset');
  await audit({ event: 'password-reset-requested', client, detail: methods.map((m) => m.kind).join(', ') });
  return NextResponse.json({ ticket, methods });
}
