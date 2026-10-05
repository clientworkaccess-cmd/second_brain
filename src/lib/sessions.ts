import fs from 'node:fs/promises';
import path from 'node:path';
import { DASHBOARD_DIR } from './config';
import { SESSION_MAX_AGE_S } from './env-auth';

/**
 * What is kept about sessions: which are open, which were revoked, and the
 * epoch that "sign out everywhere" moves on.
 *
 * In memory, written through to .dashboard/auth.json, so that a restart keeps
 * the epoch and the revocations. Read by the login route and the Security
 * page in Node; the middleware asks /api/auth/state for the epoch and the
 * revoked ids and keeps them for a few seconds.
 */

export interface SessionRecord {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The caller's address, as the proxy reported it. */
  client: string;
  /** What the browser called itself, shortened. */
  agent: string;
}

interface AuthState {
  epoch: number;
  revoked: string[];
  sessions: SessionRecord[];
}

const FILE = path.join(DASHBOARD_DIR, 'auth.json');
const MAX_REVOKED = 500;

const globalForSessions = globalThis as typeof globalThis & { __brainAuth?: { state: AuthState | null; loading: Promise<AuthState> | null } };
const kept = (globalForSessions.__brainAuth ??= { state: null, loading: null });

async function load(): Promise<AuthState> {
  if (kept.state) return kept.state;
  if (!kept.loading) {
    kept.loading = (async () => {
      let state: AuthState = { epoch: 1, revoked: [], sessions: [] };
      try {
        const parsed = JSON.parse(await fs.readFile(FILE, 'utf8')) as Partial<AuthState>;
        state = {
          epoch: Number.isInteger(parsed.epoch) && (parsed.epoch as number) >= 1 ? (parsed.epoch as number) : 1,
          revoked: Array.isArray(parsed.revoked) ? parsed.revoked.map(String) : [],
          sessions: Array.isArray(parsed.sessions) ? (parsed.sessions as SessionRecord[]) : [],
        };
      } catch {
        /* the first start, or a file nobody can read: the defaults */
      }
      kept.state = state;
      return state;
    })().finally(() => {
      kept.loading = null;
    });
  }
  return kept.loading;
}

async function save(state: AuthState): Promise<void> {
  await fs.mkdir(DASHBOARD_DIR, { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temp, FILE);
}

/** Expired sessions are forgotten as they are passed. */
function prune(state: AuthState, now = Date.now()): void {
  state.sessions = state.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  if (state.revoked.length > MAX_REVOKED) state.revoked = state.revoked.slice(-MAX_REVOKED);
}

/** What the middleware needs: the epoch, and the sessions revoked one by one. */
export async function authState(): Promise<{ epoch: number; revoked: string[] }> {
  const state = await load();
  return { epoch: state.epoch, revoked: [...state.revoked] };
}

export async function currentEpoch(): Promise<number> {
  return (await load()).epoch;
}

export async function rememberSession(id: string, client: string, agent: string, now = Date.now()): Promise<void> {
  const state = await load();
  prune(state, now);
  state.sessions.push({
    id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_MAX_AGE_S * 1000).toISOString(),
    client,
    agent: agent.slice(0, 160),
  });
  await save(state);
}

export async function listSessions(): Promise<SessionRecord[]> {
  const state = await load();
  prune(state);
  return [...state.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One session, refused from now on. */
export async function revokeSession(id: string): Promise<void> {
  const state = await load();
  if (!state.revoked.includes(id)) state.revoked.push(id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  prune(state);
  await save(state);
}

/** Every session there is, refused from now on: the epoch moves on. Returns the new epoch. */
export async function revokeAll(): Promise<number> {
  const state = await load();
  state.epoch += 1;
  state.revoked = [];
  state.sessions = [];
  await save(state);
  return state.epoch;
}

/** For the checks. */
export function forgetSessions(): void {
  kept.state = null;
}
