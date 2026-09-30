import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A second factor: the six-digit code an authenticator app shows, as RFC 6238
 * describes it (HMAC-SHA1, 30-second steps, six digits), which is what every
 * such app expects.
 *
 * Node only: the login route checks the code; the middleware never sees one.
 */

const STEP_S = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new secret, base32, as authenticator apps take it. */
export function generateSecret(bytes = 20): string {
  return toBase32(randomBytes(bytes));
}

/** The address an authenticator app reads from a QR code, or the secret typed in by hand. */
export function otpauthUrl(secret: string, account: string, issuer = 'Second Brain'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

/** The code for one 30-second step. */
export function codeAt(secret: string, counter: number): string {
  const key = fromBase32(secret);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepOf = (now: number): number => Math.floor(now / 1000 / STEP_S);

/**
 * Whether a code is right now, one step early or one step late (clocks drift).
 * Returns the step it matched, so that the same code is never taken twice.
 */
export function matchTotp(secret: string, code: string, now: number = Date.now()): number | null {
  const given = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const step = stepOf(now);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate < 0) continue;
    const expected = Buffer.from(codeAt(secret, candidate));
    if (timingSafeEqual(expected, Buffer.from(given))) return candidate;
  }
  return null;
}

/** Whether a string is a secret this module can use. */
export function isSecret(value: string): boolean {
  const clean = value.replace(/[\s=-]/g, '').toUpperCase();
  return clean.length >= 16 && [...clean].every((c) => ALPHABET.includes(c));
}

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
