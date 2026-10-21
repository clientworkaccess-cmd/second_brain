import { NextResponse } from 'next/server';
import { authorizationServerMetadata, originOf } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

/** RFC 8414, served at /.well-known/oauth-authorization-server (next.config.mjs). Public. */
export function GET(request: Request) {
  return NextResponse.json(authorizationServerMetadata(originOf(request)), { headers: { 'cache-control': 'no-store' } });
}
