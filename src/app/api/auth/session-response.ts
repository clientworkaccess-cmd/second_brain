import { NextResponse } from 'next/server';
import { audit } from '@/lib/audit';
import { SESSION_COOKIE, SESSION_MAX_AGE_S } from '@/lib/env-auth';
import { createSession, sessionIdOf } from '@/lib/session';
import { currentEpoch, rememberSession } from '@/lib/sessions';

/** The response that signs a browser in: a new session, remembered, on the trail, in the cookie. */
export async function signedIn(request: Request, client: string, how: string): Promise<NextResponse> {
  const token = await createSession(await currentEpoch());
  await rememberSession(sessionIdOf(token) ?? '', client, request.headers.get('user-agent') ?? '');
  await audit({ event: 'sign-in', client, session: token.slice(0, 8), detail: how });

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
