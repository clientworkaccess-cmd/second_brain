import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { OAuthError, registerClient } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Dynamic client registration (RFC 7591): how Claude introduces itself before
 * the owner is asked. Public; registering gives nothing by itself, and only
 * Claude's own callback addresses are accepted (lib/oauth.ts).
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { token_endpoint_auth_method?: string } | null;
    const { client, secret } = await registerClient(body);
    void audit({ event: 'mcp-registered', client: clientOf(request), detail: client.name });
    return NextResponse.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: secret ? (body?.token_endpoint_auth_method ?? 'client_secret_post') : 'none',
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof OAuthError) return NextResponse.json({ error: err.code, error_description: err.message }, { status: err.status });
    console.error('[oauth/register]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
