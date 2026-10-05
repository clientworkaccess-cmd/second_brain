/**
 * Which requests get through without a session.
 *
 * An allowlist, deliberately. Nothing here is decided by what a path looks
 * like: a dot in it, an extension, a familiar prefix. What is public is named,
 * and everything else needs a session.
 */

export type Gate = 'allow' | 'to-login' | 'to-home' | 'unauthorized';

/** `/icon.png` is the app's mark, which the browser asks for on the login page too. */
const PUBLIC_EXACT = new Set(['/login', '/api/auth/login', '/favicon.ico', '/icon.png']);

/**
 * Next's own build output. Hashed file names, no user data.
 *
 * Not `/_next/image`. The app shows no images, so nothing needs the image
 * optimizer, and it is code that fetches and decodes whatever it is pointed at.
 * It is switched off in next.config.mjs and sits behind the login like
 * everything else.
 */
const PUBLIC_PREFIXES = ['/_next/static/'];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Where to go after signing in: a path on this site, or the front page.
 *
 * The value comes from the address bar, so anyone can put anything in a link.
 * `//host` and `/\host` are read by browsers as another site, and would make
 * the login page a way to send someone who has just typed their password to a
 * page that asks for it again.
 */
export function returnPath(value: string | null | undefined): string {
  if (!value || value.length > 2000) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // Control characters and backslashes have no business in a path we hand to the router.
  if (/[\u0000-\u001f\\]/.test(value)) return '/';
  return value;
}

/**
 * The address the browser used, from what the proxy passed on.
 *
 * Only the shape of a host name is accepted, so nothing that arrives in a header
 * can put a path, a space or a line break into a redirect. Whose name it is does
 * not need checking: the proxy routes by host name, so a request only gets here
 * under the right one, and a caller who reaches the port directly and lies about
 * it redirects nobody but themselves.
 */
export function publicOrigin(
  seen: { forwardedHost: string | null; host: string | null; forwardedProto: string | null },
  fallback: string,
): string {
  // A chain of proxies lists every hop; the first is the one the browser used.
  const first = (value: string | null): string => (value ?? '').split(',')[0].trim();
  const host = first(seen.forwardedHost) || first(seen.host);
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(:\d{1,5})?$/i.test(host)) return fallback;
  const proto = first(seen.forwardedProto).toLowerCase();
  const scheme = proto === 'https' || proto === 'http' ? proto : fallback.startsWith('https:') ? 'https' : 'http';
  return `${scheme}://${host}`;
}

export function gate(pathname: string, authenticated: boolean): Gate {
  // Someone already signed in has no business on the login page.
  if (pathname === '/login') return authenticated ? 'to-home' : 'allow';
  if (isPublicPath(pathname)) return 'allow';
  if (authenticated) return 'allow';
  return pathname.startsWith('/api/') ? 'unauthorized' : 'to-login';
}
