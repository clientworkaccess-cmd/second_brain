import { NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import pkg from '../../../package.json';
import { audit, clientOf } from '@/lib/audit';
import { createBrainServer, type Called } from '@/lib/mcp';
import { SCOPE, originOf, verifyAccess } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The brain's MCP server, for Claude (lib/mcp.ts), over the official SDK's
 * Streamable HTTP transport. Public as a path (lib/gate.ts) and closed by its
 * own check: every message needs an access token from lib/oauth.ts. Without
 * one the answer says where to get one, as the MCP authorization spec asks,
 * and Claude starts the sign-in from there.
 *
 * Stateless: a server and a transport per request, answers as plain JSON, no
 * event stream (GET) and no sessions (DELETE). It runs inside the app, on the
 * app's port, behind the same nginx as every other page.
 */

/** A document sent in to be filed can be long; anything else is small. */
const MAX_BODY = 2 * 1024 * 1024;

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
  if (!grant || !token) return unauthorized(request, token ? 'The access token is not valid or has expired' : 'Sign in to use the brain');

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
      event: called.wrote ? 'mcp-filed' : 'mcp-read',
      client,
      detail: `${grant.clientName}: ${called.tool}${called.brain ? ` ${called.brain}` : ''}${called.page ? `/${called.page}` : ''}${failed ? ' (failed)' : ''}`,
    });

  const server = createBrainServer(pkg.version, onCall);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: body,
      authInfo: { token, clientId: grant.clientId, scopes: SCOPE.split(' '), expiresAt: Math.floor(grant.accessExpiresAt / 1000) },
    });
    // Read whole before the server is closed below; with JSON answers there is nothing to stream.
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.status === 202 || response.status === 204 ? null : await response.text(), { status: response.status, headers });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** No event stream from this server: everything is answered in the POST. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}

/** No sessions to end. */
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
