import { NextResponse } from 'next/server';
import pkg from '../../../package.json';
import { audit, clientOf } from '@/lib/audit';
import { handleRpc, type Called, type RpcResponse } from '@/lib/mcp';
import { originOf, verifyAccess } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The brain's MCP server, for Claude (lib/mcp.ts). Public as a path
 * (lib/gate.ts) and closed by its own check: every message needs an access
 * token from lib/oauth.ts. Without one the answer says where to get one, as
 * the MCP authorization spec asks, and Claude starts the sign-in from there.
 *
 * Streamable HTTP, answered as plain JSON: no event stream (GET), no sessions.
 */

const MAX_BODY = 256 * 1024;

function unauthorized(request: Request, description: string) {
  const origin = originOf(request);
  return NextResponse.json(
    { error: 'invalid_token', error_description: description },
    {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`,
        'cache-control': 'no-store',
      },
    },
  );
}

/** A web page may not talk to this (DNS rebinding, cross-site calls). Claude calls from its servers, without an Origin. */
function originRefused(request: Request): boolean {
  const said = request.headers.get('origin');
  if (!said) return false;
  try {
    const host = new URL(said).hostname;
    return said !== originOf(request) && host !== 'claude.ai' && host !== 'claude.com';
  } catch {
    return true;
  }
}

export async function POST(request: Request) {
  if (originRefused(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
  const grant = await verifyAccess(token);
  if (!grant) return unauthorized(request, token ? 'The access token is not valid or has expired' : 'Sign in to use the brain');

  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Too large' } }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }

  const client = clientOf(request);
  const onCall = (called: Called, failed: boolean): void =>
    void audit({
      event: 'mcp-read',
      client,
      detail: `${grant.clientName}: ${called.tool}${called.brain ? ` ${called.brain}` : ''}${called.page ? `/${called.page}` : ''}${failed ? ' (failed)' : ''}`,
    });

  const messages = Array.isArray(body) ? body.slice(0, 20) : [body];
  const answers = (await Promise.all(messages.map((m) => handleRpc(m, pkg.version, onCall)))).filter((a): a is RpcResponse => a !== null);
  if (answers.length === 0) return new Response(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? answers : answers[0], { headers: { 'cache-control': 'no-store' } });
}

/** No event stream from this server: everything is answered in the POST. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}

/** No sessions to end. */
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
