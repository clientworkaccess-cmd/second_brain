import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/env-auth';
import { gate, publicOrigin } from './lib/gate';
import { verifySession } from './lib/session';

/**
 * Every request passes through here. What gets in without a session is decided
 * by the allowlist in lib/gate.ts; whether a session is genuine by the signature
 * check in lib/session.ts.
 *
 * Route handlers do not re-check. That is safe only because the matcher below
 * covers every path — if a path is ever excluded from it, that path is public.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);

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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
