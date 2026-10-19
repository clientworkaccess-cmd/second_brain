import { NextResponse } from 'next/server';
import { version } from '../../../../package.json';

export const dynamic = 'force-dynamic';

/**
 * Whether the app is up, for a monitor or for n8n to test that it can reach
 * the app. Public (lib/gate.ts) and says nothing about any brain: only that the
 * server answers, and which version it runs.
 */
export function GET() {
  return NextResponse.json({ ok: true, version }, { headers: { 'cache-control': 'no-store' } });
}
