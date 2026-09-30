import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { sessionIdOf } from '@/lib/session';
import { revokeSession } from '@/lib/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Signing out clears the cookie, and the session is refused from now on even where a copy of it is kept. */
export async function POST(request: Request) {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  const id = sessionIdOf(token);
  if (id) await revokeSession(id);
  await audit({ event: 'sign-out', client: clientOf(request), session: token?.slice(0, 8) });

  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
