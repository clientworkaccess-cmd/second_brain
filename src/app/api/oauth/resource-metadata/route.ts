import { NextResponse } from 'next/server';
import { originOf, protectedResourceMetadata } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

/** RFC 9728, served at /.well-known/oauth-protected-resource (next.config.mjs): where to sign in to use /mcp. Public. */
export function GET(request: Request) {
  return NextResponse.json(protectedResourceMetadata(originOf(request)), { headers: { 'cache-control': 'no-store' } });
}
