import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { sessionIdOf } from '@/lib/session';
import { listSessions, revokeAll, revokeSession } from '@/lib/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The sessions that are open. GET lists them; DELETE ends one, or every one. */
export async function GET(req: NextRequest) {
  const mine = sessionIdOf(req.cookies.get(SESSION_COOKIE)?.value);
  const sessions = (await listSessions()).map((s) => ({ ...s, id: s.id.slice(0, 8), current: s.id === mine, key: s.id }));
  // The full id is what a revoke names; it is only ever sent to a signed-in browser.
  return NextResponse.json({ sessions: sessions.map(({ key, ...rest }) => ({ ...rest, key })) });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const client = clientOf(req);
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (body.all === true) {
    const epoch = await revokeAll();
    await audit({ event: 'signed-out-everywhere', client, session: token?.slice(0, 8), detail: `epoch ${epoch}` });
    const response = NextResponse.json({ success: true, everywhere: true });
    response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  }
  const key = typeof body.key === 'string' ? body.key : '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return NextResponse.json({ error: 'Which session?' }, { status: 400 });
  await revokeSession(key);
  await audit({ event: 'session-revoked', client, session: token?.slice(0, 8), detail: key.slice(0, 8) });
  const response = NextResponse.json({ success: true, everywhere: false });
  if (sessionIdOf(token) === key) response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
