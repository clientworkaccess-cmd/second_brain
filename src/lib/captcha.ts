import { createHmac } from 'node:crypto';
import { createChallenge, solveChallenge, verifySolution, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { AUTH_CAPTCHA, SESSION_SECRET } from './env-auth';

/**
 * The captcha before the sign-in: ALTCHA, self-hosted. The server hands out
 * a small proof-of-work puzzle, signed; the browser solves it; the server
 * checks the signature, the solution, the expiry, and that the same puzzle
 * is not handed in twice. Nothing leaves the server and nothing is set up
 * anywhere else. It is there to stop scripted guessing; the second factor is
 * what protects a stolen password.
 */

const ALGORITHM = 'SHA-256';
/** Hashes per try, and the prefix a try must hit: about 4,000 tries of 4 hashes on average, under a second on a phone. */
const COST = 4;
const KEY_PREFIX = '000';
const EXPIRES_MS = 2 * 60 * 1000;
const MAX_REMEMBERED = 2_000;

/** A key of its own, derived from the session secret, so the two are never confused. */
const secret = (): string => createHmac('sha256', SESSION_SECRET).update('altcha').digest('hex');

const globalForCaptcha = globalThis as typeof globalThis & { __brainCaptchaUsed?: Map<string, number> };
const used: Map<string, number> = (globalForCaptcha.__brainCaptchaUsed ??= new Map());

export const captchaOn = (): boolean => AUTH_CAPTCHA;

export async function captchaChallenge(): Promise<Challenge> {
  return createChallenge({
    algorithm: ALGORITHM,
    cost: COST,
    keyPrefix: KEY_PREFIX,
    deriveKey,
    hmacSignatureSecret: secret(),
    expiresAt: Math.floor((Date.now() + EXPIRES_MS) / 1000),
  });
}

/** What the widget hands in: the challenge and its solution, as one base64 string. */
export interface CaptchaPayload {
  challenge: Challenge;
  solution: Solution;
}

export function parsePayload(payload: unknown): CaptchaPayload | null {
  if (typeof payload !== 'string' || !payload || payload.length > 8_000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Partial<CaptchaPayload>;
    if (!parsed?.challenge?.parameters || !parsed?.solution || typeof parsed.solution.counter !== 'number') return null;
    return parsed as CaptchaPayload;
  } catch {
    return null;
  }
}

/** True when the puzzle was ours, is solved, has not expired, and has not been handed in before. */
export async function verifyCaptcha(payload: unknown, now: number = Date.now()): Promise<boolean> {
  const parsed = parsePayload(payload);
  if (!parsed) return false;
  const expiresAt = parsed.challenge.parameters.expiresAt;
  if (typeof expiresAt !== 'number' || expiresAt * 1000 < now) return false;
  let result;
  try {
    result = await verifySolution({ challenge: parsed.challenge, solution: parsed.solution, deriveKey, hmacSignatureSecret: secret() });
  } catch {
    return false;
  }
  if (!result.verified) return false;
  // Once. The nonce is random per challenge and is covered by the signature.
  const id = parsed.challenge.parameters.nonce;
  for (const [key, until] of used) if (until < now) used.delete(key);
  if (used.has(id)) return false;
  if (used.size >= MAX_REMEMBERED) used.delete(used.keys().next().value as string);
  used.set(id, expiresAt * 1000);
  return true;
}

/** Solve a challenge the way the widget does, for the checks. */
export async function solveCaptcha(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('The captcha could not be solved');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

/** For the checks. */
export function forgetCaptchas(): void {
  used.clear();
}
