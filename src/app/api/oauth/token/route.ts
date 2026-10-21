import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { OAuthError, exchange } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The token endpoint: a code (with its PKCE verifier) or a refresh token, for tokens. Public. */
export async function POST(request: Request) {
  try {
    const form = await formOf(request);
    let secret = form.get('client_secret') ?? null;
    const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (basic) {
      const [id = '', pass = ''] = Buffer.from(basic, 'base64').toString().split(':').map((p) => decodeURIComponent(p));
      if (!form.get('client_id')) form.set('client_id', id);
      secret = pass || secret;
    }
    const { tokens, created } = await exchange(form, secret);
    if (created) void audit({ event: 'mcp-connected', client: clientOf(request), detail: created.clientName });
    return NextResponse.json(tokens, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });
  } catch (err) {
    if (err instanceof OAuthError) return NextResponse.json({ error: err.code, error_description: err.message }, { status: err.status, headers: { 'cache-control': 'no-store' } });
    console.error('[oauth/token]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/** Form-encoded, as the spec has it; JSON is taken too. */
async function formOf(request: Request): Promise<Map<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text || '{}') as Record<string, unknown>;
    } catch {
      throw new OAuthError('invalid_request', 'The body is not JSON');
    }
    return new Map(Object.entries(data).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return new Map(new URLSearchParams(text));
}
