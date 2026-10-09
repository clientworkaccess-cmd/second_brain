import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { hashPassword, passwordProblem, recordFailure, recordSuccess, retryAfter, verifyPassword } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { currentPasswordHash, setPasswordHash } from '@/lib/sessions';
import { signedIn } from '../session-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A new password, from someone signed in who knows the current one. Behind
 * the gate like everything else. Every session ends with it; this browser
 * gets a fresh one in the same response.
 */
export async function POST(request: Request) {
  const client = clientOf(request);
  const wait = retryAfter(client);
  if (wait > 0) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }
  const body = (await request.json().catch(() => ({}))) as { current?: unknown; password?: unknown };
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (typeof body.current !== 'string' || !verifyPassword(body.current, await currentPasswordHash())) {
    recordFailure(client);
    const token = request.headers.get('cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    await audit({ event: 'password-refused', client, session: token?.slice(0, 8), detail: 'wrong current password' });
    return NextResponse.json({ error: 'That is not the current password' }, { status: 401 });
  }
  if (body.current === body.password) return NextResponse.json({ error: 'That is the password already' }, { status: 400 });
  const epoch = await setPasswordHash(hashPassword(body.password as string));
  recordSuccess(client);
  await audit({ event: 'password-changed', client, detail: `every session ended, epoch ${epoch}` });
  return signedIn(request, client, 'password changed');
}
