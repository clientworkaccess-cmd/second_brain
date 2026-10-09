import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { isValidCredentials, recordFailure, recordSuccess, retryAfter } from '@/lib/auth';
import { captchaOn, verifyCaptcha } from '@/lib/captcha';
import { authConfigured, secondFactorOn } from '@/lib/env-auth';
import { currentPasswordHash } from '@/lib/sessions';
import { openSignIn } from '@/lib/signin';
import { signedIn } from '../session-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The first step of a sign-in: the captcha, then the email and password.
 *
 * Where a second factor is set up, a right password gets a ticket and the
 * ways a code can reach the person, and the session comes from /api/auth/verify.
 * Where none is, the session is made here, as it always was.
 */
export async function POST(request: Request) {
  if (!authConfigured()) {
    // Never fall back to a built-in login. A server without its three values
    // set is a server nobody can sign in to.
    console.error('[auth] AUTH_EMAIL, AUTH_PASSWORD_HASH and SESSION_SECRET (32+ characters) must all be set');
    return NextResponse.json({ error: 'Sign-in is not set up on this server yet' }, { status: 503 });
  }

  const client = clientOf(request);
  const wait = retryAfter(client);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` },
      { status: 429, headers: { 'Retry-After': String(wait) } },
    );
  }

  let email: unknown;
  let password: unknown;
  let captcha: unknown;
  try {
    ({ email, password, captcha } = (await request.json()) ?? {});
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  // The captcha first, and before the password is looked at: a script that
  // cannot solve it learns nothing about the password either way.
  if (captchaOn() && !(await verifyCaptcha(captcha))) {
    return NextResponse.json({ error: 'Please complete the check and try again' }, { status: 400 });
  }

  if (!isValidCredentials(typeof email === 'string' ? email : null, typeof password === 'string' ? password : null, await currentPasswordHash())) {
    recordFailure(client);
    await audit({ event: 'sign-in-refused', client, detail: 'wrong email or password' });
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  if (secondFactorOn()) {
    const { ticket, methods } = openSignIn(client);
    await audit({ event: 'sign-in-password', client, detail: methods.map((m) => m.kind).join(', ') });
    return NextResponse.json({ ticket, methods });
  }

  recordSuccess(client);
  return signedIn(request, client, 'password alone');
}
