import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { recordFailure, recordSuccess, retryAfter } from '@/lib/auth';
import { HttpError } from '@/lib/config';
import { verifySignInCode } from '@/lib/signin';
import { signedIn } from '../session-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The code, checked; a session on a match. A wrong code counts like a wrong password. */
export async function POST(request: Request) {
  const client = clientOf(request);
  const wait = retryAfter(client);
  if (wait > 0) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { ticket?: unknown; method?: unknown; code?: unknown };
    if (!verifySignInCode(body.ticket, body.method, body.code)) {
      recordFailure(client);
      await audit({ event: 'sign-in-refused', client, detail: `wrong ${String(body.method)} code` });
      return NextResponse.json({ error: 'That code is not right' }, { status: 401 });
    }
    recordSuccess(client);
    return signedIn(request, client, `password and ${String(body.method)} code`);
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[auth/verify]', err);
    return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
  }
}
