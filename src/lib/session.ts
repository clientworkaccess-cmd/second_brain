import { SESSION_MAX_AGE_S, SESSION_SECRET } from './env-auth';

/**
 * The session cookie: `<random id>.<expiry, unix seconds>.<epoch>.<HMAC-SHA256 of the first three>`.
 *
 * Stateless in the main: the signature proves the server issued the cookie
 * and the expiry bounds its life. Two things are kept about sessions all the
 * same, in lib/sessions.ts: an epoch, which "sign out everywhere" moves on so
 * that every cookie issued before it is refused, and a list of the sessions
 * revoked one by one. The middleware learns both from /api/auth/state.
 *
 * Web Crypto only, so the same code runs in the middleware and in route
 * handlers. `crypto.subtle.verify` compares in constant time.
 */

export interface Session {
  id: string;
  /** Unix seconds. */
  expires: number;
  epoch: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(epoch: number, now: number = Date.now(), secret: string = SESSION_SECRET): Promise<string> {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_S;
  const body = `${id}.${expires}.${epoch}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The session a cookie carries, when the server issued it and it has not expired. Null otherwise. */
export async function readSession(
  token: string | null | undefined,
  now: number = Date.now(),
  secret: string = SESSION_SECRET,
): Promise<Session | null> {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, expiresRaw, epochRaw, signatureRaw] = parts;
  if (!id || !/^\d{1,12}$/.test(expiresRaw) || !/^\d{1,9}$/.test(epochRaw)) return null;
  if (Number(expiresRaw) * 1000 <= now) return null;
  const signature = fromBase64Url(signatureRaw);
  if (!signature) return null;
  try {
    const genuine = await crypto.subtle.verify('HMAC', await hmacKey(secret), signature as BufferSource, encoder.encode(`${id}.${expiresRaw}.${epochRaw}`));
    return genuine ? { id, expires: Number(expiresRaw), epoch: Number(epochRaw) } : null;
  } catch {
    return null;
  }
}

export async function verifySession(token: string | null | undefined, now: number = Date.now(), secret: string = SESSION_SECRET): Promise<boolean> {
  return (await readSession(token, now, secret)) !== null;
}

/** The id a cookie carries, unverified: for labelling, never for letting anyone in. */
export function sessionIdOf(token: string | null | undefined): string | null {
  const id = token?.split('.')[0];
  return id && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
}
