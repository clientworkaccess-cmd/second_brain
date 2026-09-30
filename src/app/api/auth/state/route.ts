import { NextResponse } from 'next/server';
import { authState } from '@/lib/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The epoch and the revoked session ids, for the middleware, which cannot read
 * a file where it runs. Public: a revoked id is of no use to anyone, and the
 * epoch is a number.
 */
export async function GET() {
  return NextResponse.json(await authState(), { headers: { 'cache-control': 'no-store' } });
}
