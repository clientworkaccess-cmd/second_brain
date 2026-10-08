import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { retryAfter } from '@/lib/auth';
import { HttpError } from '@/lib/config';
import { sendSignInCode } from '@/lib/signin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Send the code, by email or by text, for a sign-in that has passed the password. */
export async function POST(request: Request) {
  const client = clientOf(request);
  if (retryAfter(client) > 0) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  try {
    const body = (await request.json().catch(() => ({}))) as { ticket?: unknown; method?: unknown };
    const { to } = await sendSignInCode(body.ticket, body.method);
    await audit({ event: 'sign-in-code-sent', client, detail: `${String(body.method)} to ${to}` });
    return NextResponse.json({ sent: true, to });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[auth/code]', err);
    return NextResponse.json({ error: 'The code could not be sent. Try another way.' }, { status: 502 });
  }
}
