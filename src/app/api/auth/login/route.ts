import { NextResponse } from 'next/server';
import { isValidCredentials, recordFailure, recordSuccess, retryAfter } from '@/lib/auth';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, authConfigured } from '@/lib/env-auth';
import { createSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!authConfigured()) {
    // Never fall back to a built-in login. A server without its three values
    // set is a server nobody can sign in to.
    console.error('[auth] AUTH_EMAIL, AUTH_PASSWORD_HASH and SESSION_SECRET (32+ characters) must all be set');
    return NextResponse.json({ error: 'Sign-in is not set up on this server yet' }, { status: 503 });
  }

  const client = clientKey(request);
  const wait = retryAfter(client);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` },
      { status: 429, headers: { 'Retry-After': String(wait) } },
    );
  }

  let email: unknown;
  let password: unknown;
  try {
    ({ email, password } = (await request.json()) ?? {});
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  if (!isValidCredentials(typeof email === 'string' ? email : null, typeof password === 'string' ? password : null)) {
    recordFailure(client);
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  recordSuccess(client);
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, await createSession(), {
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

/** The proxy puts the caller first in X-Forwarded-For. Without a proxy every caller shares one bucket. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'direct';
}
