import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpError } from './config';
import { AUTH_CODE_EMAIL, AUTH_CODE_PHONE, AUTH_TOTP_SECRET, emailCodesOn, maskEmail, maskPhone, smsCodesOn, totpOn } from './env-auth';
import { sendMail } from './mail';
import { sendSms } from './sms';
import { matchTotp } from './totp';

/**
 * The second step of a sign-in. After the password is right, the browser
 * gets a ticket and the ways a code can reach the person: an email, a text,
 * or the authenticator app under "other ways". A code is six digits, lives
 * ten minutes, is tried at most five times, and is taken once.
 *
 * Tickets live in memory. One process, and a sign-in that spans a restart
 * simply starts again.
 */

export type Method = 'email' | 'sms' | 'totp';
/** What a ticket is for. A reset ticket cannot sign anyone in, and a sign-in ticket cannot change the password. */
export type Purpose = 'sign-in' | 'reset';

export interface MethodOffer {
  kind: Method;
  /** Where the code goes, masked. Empty for the authenticator. */
  to: string;
}

interface Ticket {
  purpose: Purpose;
  client: string;
  expires: number;
  method: Method | null;
  codeHash: string | null;
  codeExpires: number;
  attempts: number;
  sentAt: number[];
}

const TICKET_MS = 10 * 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 3;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_TICKETS = 500;

const globalForSignIn = globalThis as typeof globalThis & { __brainSignIns?: Map<string, Ticket>; __brainTotpUsed?: number };
const tickets: Map<string, Ticket> = (globalForSignIn.__brainSignIns ??= new Map());

function sweep(now: number): void {
  for (const [id, t] of tickets) if (t.expires < now) tickets.delete(id);
  while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value as string);
}

const hashOf = (code: string, ticket: string): string => createHash('sha256').update(`${ticket}:${code}`).digest('hex');

/** The ways on offer, in the order the form shows them. Empty when nothing is set up. */
export function methodsOffered(): MethodOffer[] {
  const out: MethodOffer[] = [];
  if (emailCodesOn()) out.push({ kind: 'email', to: maskEmail(AUTH_CODE_EMAIL) });
  if (smsCodesOn()) out.push({ kind: 'sms', to: maskPhone(AUTH_CODE_PHONE) });
  if (totpOn()) out.push({ kind: 'totp', to: '' });
  return out;
}

/** After the password: a ticket for the rest of the sign-in. */
export function openSignIn(client: string, now: number = Date.now(), purpose: Purpose = 'sign-in'): { ticket: string; methods: MethodOffer[] } {
  sweep(now);
  const ticket = randomBytes(18).toString('base64url');
  tickets.set(ticket, { purpose, client, expires: now + TICKET_MS, method: null, codeHash: null, codeExpires: 0, attempts: 0, sentAt: [] });
  return { ticket, methods: methodsOffered() };
}

function ticketOf(id: unknown, now: number): Ticket {
  sweep(now);
  const t = typeof id === 'string' ? tickets.get(id) : undefined;
  if (!t) throw new HttpError(410, 'That sign-in has expired. Start again.');
  return t;
}

/** Send a code the way asked. Returns where it went, masked. */
export async function sendSignInCode(id: unknown, method: unknown, now: number = Date.now()): Promise<{ to: string }> {
  const t = ticketOf(id, now);
  const offer = methodsOffered().find((m) => m.kind === method && m.kind !== 'totp');
  if (!offer) throw new HttpError(400, 'That way is not available');
  t.sentAt = t.sentAt.filter((at) => now - at < TICKET_MS);
  if (t.sentAt.length >= MAX_SENDS) throw new HttpError(429, 'Enough codes have been sent for this sign-in. Start again in a few minutes.');
  const last = t.sentAt[t.sentAt.length - 1];
  if (last !== undefined && now - last < RESEND_AFTER_MS) throw new HttpError(429, 'A code was just sent. Give it half a minute.');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  t.method = offer.kind;
  t.codeHash = hashOf(code, id as string);
  t.codeExpires = now + CODE_MS;
  t.attempts = 0;
  t.sentAt.push(now);

  const reset = t.purpose === 'reset';
  const text = reset
    ? `${code} is your Second Brain password reset code. It lasts 10 minutes. If you did not ask to reset the password, ignore this: nothing changes without the code.`
    : `${code} is your Second Brain sign-in code. It lasts 10 minutes. If you did not ask for it, someone has your password: change it.`;
  if (offer.kind === 'email') await sendMail({ to: AUTH_CODE_EMAIL, subject: `${code} is your Second Brain ${reset ? 'reset code' : 'code'}`, text });
  else await sendSms(AUTH_CODE_PHONE, text);
  return { to: offer.to };
}

/**
 * The code, checked, for a ticket opened for `purpose`. True signs in (or, for a
 * reset, lets the password change): the ticket is spent. False counts as an
 * attempt; after the fifth the ticket is spent too, and the throttle in the
 * route sees the failure like a wrong password.
 */
export function verifySignInCode(id: unknown, method: unknown, code: unknown, now: number = Date.now(), purpose: Purpose = 'sign-in'): boolean {
  const t = ticketOf(id, now);
  if (t.purpose !== purpose) return fail(id as string, t);
  const given = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(given)) return fail(id as string, t);

  if (method === 'totp') {
    if (!totpOn()) return fail(id as string, t);
    const step = matchTotp(AUTH_TOTP_SECRET, given, now);
    if (step === null || globalForSignIn.__brainTotpUsed === step) return fail(id as string, t);
    globalForSignIn.__brainTotpUsed = step;
    tickets.delete(id as string);
    return true;
  }

  if (t.method === null || t.method !== method || !t.codeHash || t.codeExpires < now) return fail(id as string, t);
  const expected = Buffer.from(t.codeHash);
  const actual = Buffer.from(hashOf(given, id as string));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return fail(id as string, t);
  tickets.delete(id as string);
  return true;
}

function fail(id: string, t: Ticket): boolean {
  t.attempts += 1;
  if (t.attempts >= MAX_ATTEMPTS) tickets.delete(id);
  return false;
}

/** For the checks. */
export function forgetSignIns(): void {
  tickets.clear();
  delete globalForSignIn.__brainTotpUsed;
}
