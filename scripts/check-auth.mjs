#!/usr/bin/env node
/**
 * Sign-in: what gets through without a session, what counts as a session, what
 * counts as the right password, and what happens to someone who keeps guessing.
 *
 *   npm run check:auth
 *
 * These are the decisions themselves (lib/gate.ts, lib/session.ts, lib/auth.ts),
 * called directly. The middleware and the login route are thin wrappers around
 * them; set BASE_URL to a running server to check those too:
 *
 *   BASE_URL=http://localhost:3000 npm run check:auth
 */
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const PASSWORD = 'a password made up for this check';
const salt = randomBytes(16);
process.env.AUTH_EMAIL = 'Someone@Example.com';
// Built by hand rather than with hashPassword(), so that a change to the format
// in auth.ts has to be made twice, on purpose: hashes already in env files
// must keep working.
process.env.AUTH_PASSWORD_HASH = ['scrypt', 16384, 8, 1, salt.toString('base64url'), scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')].join(':');
process.env.SESSION_SECRET = randomBytes(48).toString('base64url');

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { gate, isPublicPath, returnPath, publicOrigin } = await import(lib('gate'));
const { createSession, verifySession, readSession, sessionIdOf } = await import(lib('session'));
const totp = await import(lib('totp'));
const auth = await import(lib('auth'));
const { authConfigured, SESSION_MAX_AGE_S } = await import(lib('env-auth'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ------------------------------------------------------------------ the gate
// Every route the app has, plus shapes that a looser rule would let through.
const PROTECTED = [
  '/', '/new', '/c/ops', '/c/ops/graph', '/c/ops/ask', '/c/ops/entities/warehouse-team',
  '/api/clusters', '/api/upload', '/api/chat', '/api/jobs/abc', '/api/pipeline/plan', '/api/pipeline/execute',
  '/api/pipeline/reject', '/api/pipeline/undo', '/api/auth/logout', '/api/search', '/api/clusters/settings', '/api/page', '/api/auth/sessions', '/security', '/api/asset', '/api/assets', '/api/asset?cluster=ops&path=raw%2Fassets%2Fa.png',
  // A dot in a path says nothing about what the path is.
  '/api/clusters.json', '/api/x.json', '/c/a.b', '/c/ops/entities/page.md', '/new.html', '/.env', '/api/auth/login.php',
  // Near misses of the public paths.
  '/login/', '/login/extra', '/LOGIN', '/api/auth/login/', '/_next', '/_next/data/x.json', '/_nextstatic/x.js', '/favicon.ico/x',
  // The image optimizer. Nothing in the app uses it, so nothing needs it open.
  '/_next/image', '/_next/image/',
  // Near misses of the app's mark, which is public.
  '/icon.png/', '/icon.png/x', '/icons.png', '/c/icon.png',
];
const leaks = PROTECTED.filter((p) => gate(p, false) === 'allow');
check('nothing protected gets through without a session', leaks.length === 0, leaks.length ? `open: ${leaks.join(', ')}` : `${PROTECTED.length} paths`);
check('API routes answer 401, pages go to the login', gate('/api/clusters', false) === 'unauthorized' && gate('/c/ops', false) === 'to-login');
check('the login page and its endpoint are reachable', gate('/login', false) === 'allow' && gate('/api/auth/login', false) === 'allow');
check('the epoch and the revoked ids are reachable, for the middleware', gate('/api/auth/state', false) === 'allow' && gate('/api/auth/state/', false) !== 'allow' && gate('/api/auth/states', false) !== 'allow');
check('build output is reachable', isPublicPath('/_next/static/chunks/main.js') && isPublicPath('/favicon.ico'));
check('the app’s mark is reachable, so the login page can show it', isPublicPath('/icon.png'));
check('a signed-in visitor is sent away from the login page', gate('/login', true) === 'to-home');
check('a signed-in visitor gets everything else', PROTECTED.every((p) => gate(p, true) === 'allow'));

// After signing in, only ever to a page of this site.
const ELSEWHERE = ['https://example.com', 'http://example.com/login', '//example.com', '//example.com/c/ops', '/\\example.com', '/\\/example.com', 'javascript:alert(1)', 'example.com', ' /c/ops', '/c/ops\nx', '/c\\ops', '', null, undefined, `/${'a'.repeat(3000)}`];
const followed = ELSEWHERE.filter((v) => returnPath(v) !== '/');
check('a link cannot send someone elsewhere after sign-in', followed.length === 0, followed.map(String).join(', ').slice(0, 120));
check('a page of this site is returned to', returnPath('/c/ops/entities/warehouse-team') === '/c/ops/entities/warehouse-team' && returnPath('/c/a.b?x=1') === '/c/a.b?x=1');

// Redirects go to the address the browser used, not to the server's own.
const INSIDE = 'http://localhost:3003';
const seen = (forwardedHost, host, forwardedProto) => publicOrigin({ forwardedHost, host, forwardedProto }, INSIDE);
check('behind the proxy, redirects use the public address', seen('brain.example.com', 'brain.example.com', 'https') === 'https://brain.example.com');
check('without a proxy, the address that was asked for', seen(null, 'localhost:3000', null) === 'http://localhost:3000' && seen(null, '127.0.0.1:3003', null) === 'http://127.0.0.1:3003' && seen(null, '[::1]:3000', null) === 'http://[::1]:3000');
check('through several proxies, the first one named', seen('brain.example.com, inner.local', 'inner.local', 'https, http') === 'https://brain.example.com');
const BAD_HOSTS = ['example.com/path', 'example.com?x', 'exa mple.com', 'example.com\r\nSet-Cookie: x=1', 'user@example.com', 'example.com:port', '-example.com', '', 'example.com#x', 'http://example.com'];
const taken = BAD_HOSTS.filter((h) => seen(h, null, 'https') !== INSIDE);
check('a host header that is not a host name is ignored', taken.length === 0, JSON.stringify(taken));
check('a scheme that is not http or https is ignored', seen('brain.example.com', null, 'javascript') === 'http://brain.example.com');

// -------------------------------------------------------------- the session
const now = Date.UTC(2026, 8, 28);
const token = await createSession(1, now);
const [id, expires, epoch, signature] = token.split('.');
check('a fresh session verifies', await verifySession(token, now));
check('two sessions are never the same', (await createSession(1, now)) !== token);
check('it expires', !(await verifySession(token, now + (SESSION_MAX_AGE_S + 1) * 1000)));
check('a longer life cannot be written in', !(await verifySession(`${id}.${Number(expires) + 86400}.${epoch}.${signature}`, now)));
check('another id cannot be written in', !(await verifySession(`x${id}.${expires}.${epoch}.${signature}`, now)));
check('another epoch cannot be written in', !(await verifySession(`${id}.${expires}.${Number(epoch) + 1}.${signature}`, now)));
check('the session says which epoch it is from', (await readSession(token, now))?.epoch === 1 && (await readSession(await createSession(7, now), now))?.epoch === 7);
check('the id can be read off a cookie without the secret', sessionIdOf(token) === id && sessionIdOf('authenticated') === null && sessionIdOf('') === null);
check('a signature from another secret is refused', !(await verifySession(await createSession(1, now, 'a'.repeat(48)), now)));
check('a fixed string is not a session', !(await verifySession('authenticated', now)));
const junk = ['', 'a', 'a.b', 'a.b.c', 'a.b.c.d', '...', `${id}.${expires}.${epoch}.`, `${id}..${epoch}.${signature}`, `${id}.${expires}.${epoch}.${signature}.x`, `${id}.${expires}.${signature}`, `${id}.1e9.${epoch}.${signature}`, `${id}.${expires}.-1.${signature}`, null, undefined];
const accepted = [];
for (const value of junk) if (await verifySession(value, now)) accepted.push(String(value));
check('malformed cookies are refused', accepted.length === 0, accepted.join(', '));
check('no secret, no session', !(await verifySession(token, now, '')));

// -------------------------------------------------------- the second factor
// The vectors of RFC 6238, appendix B: the ASCII secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
check('the code is what the standard says it is', totp.codeAt(RFC_SECRET, 1) === '287082' && totp.codeAt(RFC_SECRET, 0x23523EC) === '081804' && totp.codeAt(RFC_SECRET, 0x27BC86AA) === '353130');
check('the code of the moment is taken, with spaces or without', totp.matchTotp(RFC_SECRET, '287082', 59_000) === 1 && totp.matchTotp(RFC_SECRET, '287 082', 59_000) === 1);
check('one step early and one step late are taken, for clocks that drift', totp.matchTotp(RFC_SECRET, '287082', 30_000) === 1 && totp.matchTotp(RFC_SECRET, '287082', 89_000) === 1);
check('two steps away is not', totp.matchTotp(RFC_SECRET, '287082', 120_000) === null && totp.matchTotp(RFC_SECRET, '287082', 150_000) === null);
check('the first step of all has no step before it to look at', totp.matchTotp(RFC_SECRET, '000000', 0) === null && totp.matchTotp(RFC_SECRET, totp.codeAt(RFC_SECRET, 0), 0) === 0);
check('a wrong code is refused', totp.matchTotp(RFC_SECRET, '287083', 59_000) === null && totp.matchTotp(RFC_SECRET, '', 59_000) === null && totp.matchTotp(RFC_SECRET, '28708', 59_000) === null && totp.matchTotp(RFC_SECRET, '2870822', 59_000) === null && totp.matchTotp(RFC_SECRET, 'abcdef', 59_000) === null);
const fresh = totp.generateSecret();
check('a new secret is base32 and long enough for any app', totp.isSecret(fresh) && fresh.length === 32 && totp.generateSecret() !== fresh);
check('the setup address carries the secret and the account', totp.otpauthUrl(fresh, 'someone@example.com').startsWith(`otpauth://totp/Second%20Brain%3Asomeone%40example.com?secret=${fresh}&issuer=Second%20Brain&`));
check('a secret with spaces and dashes still works', totp.codeAt('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 1) === '287082');

// ------------------------------------------------------------- the password
check('sign-in is configured', authConfigured());
check('the right email and password are accepted', auth.isValidCredentials('someone@example.com', PASSWORD));
check('the email is matched without regard to case or padding', auth.isValidCredentials('  SOMEONE@example.COM ', PASSWORD));
check('a wrong password is refused', !auth.isValidCredentials('someone@example.com', `${PASSWORD}!`));
check('a wrong email is refused', !auth.isValidCredentials('someone.else@example.com', PASSWORD));
check('empty and missing values are refused', !auth.isValidCredentials('', '') && !auth.isValidCredentials(null, null) && !auth.isValidCredentials('someone@example.com', ''));
check('the stored hash is not a password', !auth.isValidCredentials('someone@example.com', process.env.AUTH_PASSWORD_HASH));
check('a hash made by the app verifies', auth.verifyPassword('another one', auth.hashPassword('another one')));
check('a damaged hash is refused, not thrown on', !auth.verifyPassword(PASSWORD, 'scrypt:16384:8:1::') && !auth.verifyPassword(PASSWORD, 'plain') && !auth.verifyPassword(PASSWORD, ''));
check('absurd scrypt parameters are refused', !auth.verifyPassword(PASSWORD, process.env.AUTH_PASSWORD_HASH.replace(':16384:', ':1073741824:')));
check('a shortened hash is refused', !auth.verifyPassword(PASSWORD, process.env.AUTH_PASSWORD_HASH.slice(0, -40)));
check('the hash survives an env file', !/[$'"\s#=]/.test(auth.hashPassword('anything at all')), auth.hashPassword('x').replace(/[A-Za-z0-9_-]{20,}/g, '…'));

// ------------------------------------------------------------- the throttle
auth.resetSignInAttempts();
const t0 = 1_000_000;
for (let i = 0; i < 4; i++) auth.recordFailure('10.0.0.1', t0 + i);
check('four wrong guesses are tolerated', auth.retryAfter('10.0.0.1', t0 + 10) === 0);
auth.recordFailure('10.0.0.1', t0 + 20);
check('the fifth blocks that caller', auth.retryAfter('10.0.0.1', t0 + 30) > 0, `${auth.retryAfter('10.0.0.1', t0 + 30)} s`);
check('another caller is not blocked', auth.retryAfter('10.0.0.2', t0 + 30) === 0);
check('the block ends', auth.retryAfter('10.0.0.1', t0 + 16 * 60 * 1000) === 0);
auth.resetSignInAttempts();
for (let i = 0; i < 50; i++) auth.recordFailure(`10.1.0.${i}`, t0 + i);
check('guessing from many addresses blocks everyone for a while', auth.retryAfter('10.9.9.9', t0 + 100) > 0);
auth.resetSignInAttempts();
auth.recordFailure('10.0.0.3', t0);
auth.recordSuccess('10.0.0.3');
for (let i = 0; i < 4; i++) auth.recordFailure('10.0.0.3', t0 + i);
check('a successful sign-in clears the count', auth.retryAfter('10.0.0.3', t0 + 10) === 0);

// ------------------------------------------------------- a running server
const base = process.env.BASE_URL?.replace(/\/$/, '');
if (!base) {
  console.log('SKIP  live requests  — set BASE_URL to check a running server');
} else {
  const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
  for (const p of ['/api/clusters', '/api/clusters.json', '/api/x.json']) {
    const res = await get(p);
    check(`live: ${p} without a session is 401`, res.status === 401, String(res.status));
  }
  for (const p of ['/', '/c/ops', '/c/a.b', '/new.html']) {
    const res = await get(p);
    check(`live: ${p} without a session goes to the login`, [302, 307, 308].includes(res.status) && (res.headers.get('location') ?? '').includes('/login'), `${res.status} ${res.headers.get('location') ?? ''}`);
  }
  const forged = await get('/api/clusters', { cookie: `brain_session=authenticated; other=${await createSession(1, Date.now(), 'b'.repeat(48))}` });
  check('live: a made-up cookie is refused', forged.status === 401, String(forged.status));
  const wrong = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'not the password' }),
  });
  check('live: a wrong login is refused', wrong.status === 401 || wrong.status === 429 || wrong.status === 503, String(wrong.status));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
