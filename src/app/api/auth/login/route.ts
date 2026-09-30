import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { isValidCredentials, recordFailure, recordSuccess, retryAfter } from '@/lib/auth';
import { AUTH_TOTP_SECRET, SESSION_COOKIE, SESSION_MAX_AGE_S, authConfigured, secondFactorOn } from '@/lib/env-auth';
import { createSession, sessionIdOf } from '@/lib/session';
import { currentEpoch, rememberSession } from '@/lib/sessions';
import { matchTotp } from '@/lib/totp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A code is taken once: the step it matched is remembered until it has passed. */
const globalForTotp = globalThis as typeof globalThis & { __brainTotpUsed?: number };

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
  let code: unknown;
  try {
    ({ email, password, code } = (await request.json()) ?? {});
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const refuse = async (reason: string) => {
    recordFailure(client);
    await audit({ event: 'sign-in-refused', client, detail: reason });
    return NextResponse.json({ error: secondFactorOn() ? 'Invalid email, password or code' : 'Invalid email or password' }, { status: 401 });
  };

  if (!isValidCredentials(typeof email === 'string' ? email : null, typeof password === 'string' ? password : null)) {
    return refuse('wrong email or password');
  }

  // The second factor, where it is set up. The password is checked first and
  // always, so a wrong code costs the same as a wrong password.
  if (secondFactorOn()) {
    const step = matchTotp(AUTH_TOTP_SECRET, typeof code === 'string' ? code : '');
    if (step === null) return refuse('wrong code');
    if (globalForTotp.__brainTotpUsed === step) return refuse('a code used already');
    globalForTotp.__brainTotpUsed = step;
  }

  recordSuccess(client);
  const token = await createSession(await currentEpoch());
  await rememberSession(sessionIdOf(token) ?? '', client, request.headers.get('user-agent') ?? '');
  await audit({ event: 'sign-in', client, session: token.slice(0, 8) });

  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
    // Behind the proxy the app itself is reached over plain HTTP on loopback,
    // so the request URL alone would always say "not secure".
    secure: request.headers.get('x-forwarded-proto') === 'https' || request.url.startsWith('https://'),
  });
  return response;
}
