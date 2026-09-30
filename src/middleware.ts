import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/env-auth';
import { gate, publicOrigin } from './lib/gate';
import { readSession } from './lib/session';

/**
 * Every request passes through here. What gets in without a session is decided
 * by the allowlist in lib/gate.ts; whether a session is genuine by the signature
 * check in lib/session.ts; and whether it is still wanted by the epoch and the
 * revocations, which this file learns from /api/auth/state and keeps for a
 * few seconds (it cannot read a file where it runs).
 *
 * Route handlers do not re-check. That is safe only because the matcher below
 * covers every path — if a path is ever excluded from it, that path is public.
 */

interface Known {
  epoch: number;
  revoked: Set<string>;
  at: number;
}

/**
 * How long the epoch and the revocations are trusted before they are asked
 * for again: the most a session ended elsewhere can go on for.
 */
const KEEP_MS = 5_000;
let known: Known | null = null;
let asking: Promise<Known | null> | null = null;

/**
 * The epoch and the revocations, from this same server. Asked over loopback:
 * the address the browser used is not the one the server answers on.
 */
async function state(request: NextRequest): Promise<Known | null> {
  if (known && Date.now() - known.at < KEEP_MS) return known;
  if (!asking) {
    const port = request.nextUrl.port || (request.nextUrl.protocol === 'https:' ? '443' : '80');
    asking = fetch(`http://127.0.0.1:${port}/api/auth/state`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { epoch: number; revoked: string[] };
        known = { epoch: Number(data.epoch) || 1, revoked: new Set(data.revoked ?? []), at: Date.now() };
        return known;
      })
      .catch(() => known) // what was known lasts a little longer; nothing known means nothing is refused for it
      .finally(() => {
        asking = null;
      });
  }
  return asking;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  let authenticated = session !== null;
  if (session) {
    const current = await state(request);
    if (current && (session.epoch !== current.epoch || current.revoked.has(session.id))) authenticated = false;
  }

  switch (gate(pathname, authenticated)) {
    case 'allow':
      return NextResponse.next();
    case 'to-home':
      return redirectTo(request, '/');
    case 'unauthorized':
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    case 'to-login':
      return redirectTo(request, pathname === '/' ? '/login' : `/login?from=${encodeURIComponent(pathname)}`);
  }
}

/**
 * A redirect to a path of this site, at the address the browser used.
 *
 * Not `new URL(path, request.url)`. Behind the proxy `request.url` is the
 * server's own idea of its address, `localhost:3003`, whatever the browser
 * asked for, and a redirect built from it sends the browser there.
 */
function redirectTo(request: NextRequest, location: string): NextResponse {
  const origin = publicOrigin(
    {
      forwardedHost: request.headers.get('x-forwarded-host'),
      host: request.headers.get('host'),
      forwardedProto: request.headers.get('x-forwarded-proto'),
    },
    request.nextUrl.origin,
  );
  return NextResponse.redirect(`${origin}${location}`, 307);
}

export const config = {
  // Everything except Next's own hashed build output, which gate.ts would let
  // through anyway. Listed here only to skip the cookie check on asset requests.
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};
