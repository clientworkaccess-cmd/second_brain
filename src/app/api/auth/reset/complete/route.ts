import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { hashPassword, passwordProblem, recordFailure, recordSuccess, retryAfter } from '@/lib/auth';
import { HttpError } from '@/lib/config';
import { setPasswordHash } from '@/lib/sessions';
import { verifySignInCode } from '@/lib/signin';
import { signedIn } from '../../session-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The end of a reset: the code and the new password together. A right code
 * sets the password, ends every session there was, and signs this browser in.
 * A wrong code counts like a wrong password.
 */
export async function POST(request: Request) {
  const client = clientOf(request);
  const wait = retryAfter(client);
  if (wait > 0) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { ticket?: unknown; method?: unknown; code?: unknown; password?: unknown };
    // The password is judged before the code is spent, so a weak one can be
    // retyped without asking for another code.
    const problem = passwordProblem(body.password);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    if (!verifySignInCode(body.ticket, body.method, body.code, Date.now(), 'reset')) {
      recordFailure(client);
      await audit({ event: 'sign-in-refused', client, detail: `wrong ${String(body.method)} reset code` });
      return NextResponse.json({ error: 'That code is not right' }, { status: 401 });
    }
    const epoch = await setPasswordHash(hashPassword(body.password as string));
    recordSuccess(client);
    await audit({ event: 'password-reset', client, detail: `by ${String(body.method)} code; every session ended, epoch ${epoch}` });
    return signedIn(request, client, 'password reset');
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[auth/reset/complete]', err);
    return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
  }
}
