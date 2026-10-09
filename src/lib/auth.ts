import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AUTH_EMAIL, AUTH_PASSWORD_HASH } from './env-auth';

/**
 * One shared login, checked against values from the environment.
 *
 * Node only — scrypt is not available where the middleware runs, and the
 * middleware does not need it: it verifies the session cookie (session.ts),
 * never a password.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/**
 * `scrypt:N:r:p:<salt>:<hash>`, salt and hash in base64url — what goes in
 * AUTH_PASSWORD_HASH.
 *
 * Colons and base64url because the value has to survive an env file untouched.
 * The usual `$`-separated form does not: Next's env loader expands `$name`
 * inside values, quoted or not, and what arrives is a hash with holes in it.
 */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6) return false;
  const [scheme, n, r, p, saltRaw, hashRaw] = parts;
  if (scheme !== 'scrypt' || !saltRaw || !hashRaw) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  // Refuse parameters far beyond what hashPassword() writes: a hash string is
  // configuration, and a typo in it should not be able to stall the process.
  if (params.N > 2 ** 17 || params.r > 16 || params.p > 4) return false;
  try {
    const expected = Buffer.from(hashRaw, 'base64url');
    // A short hash would be a weak one; hashPassword() always writes KEY_LENGTH.
    if (expected.length !== KEY_LENGTH) return false;
    const actual = scryptSync(password, Buffer.from(saltRaw, 'base64url'), KEY_LENGTH, params);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Whether the address is the sign-in address. */
export function isSignInEmail(email: unknown): boolean {
  return typeof email === 'string' && email !== '' && safeEqual(email.trim().toLowerCase(), AUTH_EMAIL);
}

/** `hash` is the one in force: the env value, or the one set in the app (sessions.ts knows which). */
export function isValidCredentials(email?: string | null, password?: string | null, hash: string = AUTH_PASSWORD_HASH): boolean {
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return false;
  // Both halves are always evaluated, so a wrong email costs the same time as
  // a wrong password.
  const emailOk = isSignInEmail(email);
  const passwordOk = verifyPassword(password, hash);
  return emailOk && passwordOk;
}

export const MIN_PASSWORD_LENGTH = 12;

/** Why a new password will not do, or null when it will. The same rule as `npm run hash-password`. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return 'That is longer than a password needs to be.';
  if (password.trim() !== password) return 'No spaces at the start or the end.';
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Failed sign-ins, per client and overall.
 *
 * In memory and on globalThis for the same reason as the job runtime: Next can
 * give each route bundle its own copy of a module, and there is exactly one
 * process. A restart clears it, which is acceptable — a restart is not something
 * an attacker can trigger.
 */
interface Attempts {
  failures: number;
  windowStart: number;
  blockedUntil: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_FAILURES_OVERALL = 50;
const OVERALL = '*';

const globalForAuth = globalThis as typeof globalThis & { __brainSignIn?: Map<string, Attempts> };
const attempts: Map<string, Attempts> = (globalForAuth.__brainSignIn ??= new Map());

/** Seconds the caller has to wait, or 0 when a sign-in attempt is allowed. */
export function retryAfter(client: string, now: number = Date.now()): number {
  let wait = 0;
  for (const key of [client, OVERALL]) {
    const entry = attempts.get(key);
    if (entry && entry.blockedUntil > now) wait = Math.max(wait, Math.ceil((entry.blockedUntil - now) / 1000));
  }
  return wait;
}

export function recordFailure(client: string, now: number = Date.now()): void {
  bump(client, MAX_FAILURES, now);
  bump(OVERALL, MAX_FAILURES_OVERALL, now);
  // Entries are tiny, but an attacker chooses how many there are.
  if (attempts.size > 5000) {
    for (const [key, entry] of attempts) {
      if (entry.blockedUntil <= now && now - entry.windowStart > WINDOW_MS) attempts.delete(key);
    }
  }
}

export function recordSuccess(client: string): void {
  attempts.delete(client);
}

function bump(key: string, limit: number, now: number): void {
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { failures: 1, windowStart: now, blockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= limit) entry.blockedUntil = now + WINDOW_MS;
}

/** For tests. */
export function resetSignInAttempts(): void {
  attempts.clear();
}
