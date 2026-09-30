/**
 * Sign-in settings.
 *
 * This is part of config.ts in spirit — the rule that nothing else reads
 * process.env still holds, and config.ts re-exports everything here. It lives
 * in its own file because the middleware imports it, and the middleware must
 * not pull in `node:path` and friends through config.ts.
 *
 * No Node imports in this file, and none in anything it imports.
 */

export const AUTH_EMAIL = (process.env.AUTH_EMAIL ?? '').trim().toLowerCase();

/** `scrypt:N:r:p:salt:hash`, produced by `npm run hash-password`. */
export const AUTH_PASSWORD_HASH = (process.env.AUTH_PASSWORD_HASH ?? '').trim();

/** Signs the session cookie. Changing it signs everyone out. */
export const SESSION_SECRET = process.env.SESSION_SECRET ?? '';

/**
 * The second factor, produced by `npm run totp-secret`. Set, the sign-in asks
 * for the six-digit code an authenticator app shows as well as the password.
 * Empty, it asks for the password alone.
 */
export const AUTH_TOTP_SECRET = (process.env.AUTH_TOTP_SECRET ?? '').replace(/[\s=-]/g, '').toUpperCase();

export const SESSION_COOKIE = 'brain_session';
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

const MIN_SECRET_LENGTH = 32;

/**
 * Sign-in only works when all three values are set. A half-configured server
 * refuses every login rather than falling back to anything built in.
 */
export function authConfigured(): boolean {
  return AUTH_EMAIL !== '' && AUTH_PASSWORD_HASH !== '' && SESSION_SECRET.length >= MIN_SECRET_LENGTH;
}

/** Whether a code is asked for at sign-in. */
export function secondFactorOn(): boolean {
  return AUTH_TOTP_SECRET.length >= 16;
}
