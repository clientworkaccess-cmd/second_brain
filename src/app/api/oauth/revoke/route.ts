import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { revokeToken } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** RFC 7009: a client ending its own connection. Public; always 200, as the spec asks. */
export async function POST(request: Request) {
  const text = await request.text();
  let token = new URLSearchParams(text).get('token') ?? '';
  if (!token) {
    try {
      token = (JSON.parse(text) as { token?: string }).token ?? '';
    } catch {
      /* not JSON either: nothing to revoke */
    }
  }
  if (token) {
    const ended = await revokeToken(token);
    if (ended) void audit({ event: 'mcp-disconnected', client: clientOf(request), detail: `${ended.clientName} (by the app)` });
  }
  return new NextResponse(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
