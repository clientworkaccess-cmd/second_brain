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

const text = (name: string): string => (process.env[name] ?? '').trim();

export const AUTH_EMAIL = text('AUTH_EMAIL').toLowerCase();

/** `scrypt:N:r:p:salt:hash`, produced by `npm run hash-password`. */
export const AUTH_PASSWORD_HASH = text('AUTH_PASSWORD_HASH');

/** Signs the session cookie. Changing it signs everyone out. */
export const SESSION_SECRET = process.env.SESSION_SECRET ?? '';

/**
 * An authenticator app as a second factor, produced by `npm run totp-secret`.
 * Set, "Other ways" on the sign-in offers the six-digit code the app shows.
 */
export const AUTH_TOTP_SECRET = text('AUTH_TOTP_SECRET').replace(/[\s=-]/g, '').toUpperCase();

/** Where a sign-in code is sent: an address, and a phone number in +15185550123 form. */
export const AUTH_CODE_EMAIL = (text('AUTH_CODE_EMAIL') || AUTH_EMAIL).toLowerCase();
export const AUTH_CODE_PHONE = text('AUTH_CODE_PHONE').replace(/[\s().-]/g, '');

/** Outgoing mail, for the sign-in code. A Google Workspace mailbox with an app password works as is. */
export const SMTP_HOST = text('SMTP_HOST');
export const SMTP_PORT = Number(text('SMTP_PORT') || '465');
export const SMTP_USER = text('SMTP_USER');
export const SMTP_PASS = process.env.SMTP_PASS ?? '';
export const MAIL_FROM = text('MAIL_FROM') || SMTP_USER;

/** Text messages, for the sign-in code, through GoHighLevel: a private integration token and the sub-account. */
export const GHL_API_KEY = process.env.GHL_API_KEY ?? '';
export const GHL_LOCATION_ID = text('GHL_LOCATION_ID');

/**
 * Where codes are written instead of sent, for the checks and for a dev
 * machine with no mail set up. A folder; one JSON file per code. Never set
 * this on the server.
 */
export const CODE_CAPTURE_DIR = text('CODE_CAPTURE_DIR');

/** The captcha before the code. On unless `AUTH_CAPTCHA=off`. */
export const AUTH_CAPTCHA = text('AUTH_CAPTCHA').toLowerCase() !== 'off';

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

/** Whether an authenticator app is set up. */
export function totpOn(): boolean {
  return AUTH_TOTP_SECRET.length >= 16;
}

/** Whether a code can be emailed: a mailbox to send from and an address to send to, or the capture folder. */
export function emailCodesOn(): boolean {
  return AUTH_CODE_EMAIL !== '' && (CODE_CAPTURE_DIR !== '' || (SMTP_HOST !== '' && SMTP_USER !== '' && SMTP_PASS !== ''));
}

/** Whether a code can be texted: GoHighLevel and a number to text, or the capture folder. */
export function smsCodesOn(): boolean {
  return /^\+\d{8,15}$/.test(AUTH_CODE_PHONE) && (CODE_CAPTURE_DIR !== '' || (GHL_API_KEY !== '' && GHL_LOCATION_ID !== ''));
}

/** Whether the sign-in asks for anything after the password. */
export function secondFactorOn(): boolean {
  return emailCodesOn() || smsCodesOn() || totpOn();
}

/** `ptraynor@example.com` -> `pt******@example.com`: enough to recognise, not enough to copy. */
export function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return address ? '***' : '';
  const name = address.slice(0, at);
  const kept = name.slice(0, Math.min(2, name.length));
  return `${kept}${'*'.repeat(Math.max(4, name.length - kept.length))}@${address.slice(at + 1)}`;
}

/** `+15182532468` -> `+1 (518) *****68`; other countries `+44 ****68`. */
export function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (!digits) return '';
  const last = digits.slice(-2);
  if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) *****${last}`;
  return `+${digits.slice(0, 2)} ${'*'.repeat(Math.max(3, digits.length - 4))}${last}`;
}
