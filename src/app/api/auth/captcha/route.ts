import { NextResponse } from 'next/server';
import { captchaChallenge, captchaOn } from '@/lib/captcha';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A fresh puzzle for the sign-in form. Public: it is the first thing the form needs. */
export async function GET() {
  if (!captchaOn()) return NextResponse.json({ error: 'The captcha is off' }, { status: 404 });
  return NextResponse.json(await captchaChallenge(), { headers: { 'cache-control': 'no-store' } });
}
