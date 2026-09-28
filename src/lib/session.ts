import { SESSION_MAX_AGE_S, SESSION_SECRET } from './env-auth';

/**
 * The session cookie: `<random id>.<expiry, unix seconds>.<HMAC-SHA256 of the first two>`.
 *
 * Stateless on purpose. There is one shared login and one process, so there is
 * nothing to look up — the signature proves the server issued the cookie and the
 * expiry bounds its life. Signing out deletes the cookie; changing
 * SESSION_SECRET invalidates every cookie at once.
 *
 * Web Crypto only, so the same code runs in the middleware and in route
 * handlers. `crypto.subtle.verify` compares in constant time.
 */

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

export async function createSession(now: number = Date.now(), secret: string = SESSION_SECRET): Promise<string> {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_S;
  const body = `${id}.${expires}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(
  token: string | null | undefined,
  now: number = Date.now(),
  secret: string = SESSION_SECRET,
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [id, expiresRaw, signatureRaw] = parts;
  if (!id || !/^\d{1,12}$/.test(expiresRaw)) return false;
  if (Number(expiresRaw) * 1000 <= now) return false;
  const signature = fromBase64Url(signatureRaw);
  if (!signature) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), signature as BufferSource, encoder.encode(`${id}.${expiresRaw}`));
  } catch {
    return false;
  }
}
