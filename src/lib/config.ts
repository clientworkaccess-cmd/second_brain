import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * All filesystem and process configuration lives here. Nothing else in the app
 * reads process.env directly.
 *
 * The one exception in layout, not in principle, is env-auth.ts: the sign-in
 * values live there because the middleware imports them and must not pull in
 * Node modules. They are re-exported below so there is still one place to look.
 */
export * from './env-auth';

/**
 * Where the app itself lives: the checkout, with prompts/ and scripts/ in it.
 *
 * Not simply the working directory. The production server (.next/standalone/
 * server.js) changes into its own folder before anything of ours runs, so there
 * the working directory is two levels below the checkout. APP_DIR overrides the
 * guess for any layout this does not cover.
 */
export const APP_DIR = appDir();

function appDir(): string {
  const fromEnv = (process.env.APP_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const cwd = process.cwd();
  return cwd.endsWith(path.join('.next', 'standalone')) ? path.resolve(cwd, '..', '..') : cwd;
}

/**
 * Always absolute. `./.wiki-dev` in an env file is a path from the checkout,
 * not from wherever the server happens to be standing. Left relative, every
 * cluster path failed its own "does this stay inside the cluster" test, which
 * compares against the resolved form.
 */
export const WIKI_ROOT = path.resolve(APP_DIR, (process.env.WIKI_ROOT ?? '').trim() || '.wiki-dev');

/**
 * The spawn seam. On the VPS this is the real `claude` binary; locally it is
 * scripts/fake-claude.mjs, which speaks the same stream-json protocol so the
 * whole UI can be built with no login, no usage and no real documents.
 *
 * Read when a run starts rather than once at import. The check scripts switch
 * the fake's behaviour between runs; with a constant, the switch that makes the
 * planner misbehave was silently ignored and the test that depends on it could
 * not fail.
 */
export function claudeCommand(): string {
  return resolveIfLocal(process.env.CLAUDE_CMD ?? 'node');
}

/**
 * Args placed before the ones we generate. Exists so the local fake can be
 * `node scripts/fake-claude.mjs`.
 *
 * Anything here that names a file inside the app is made absolute: the agent
 * runs with the cluster as its working directory, so a relative script path
 * would be looked up inside the wiki.
 */
export function claudeArgs(): string[] {
  return (process.env.CLAUDE_ARGS ?? 'scripts/fake-claude.mjs')
    .split(' ')
    .filter(Boolean)
    .map((arg) => (arg.startsWith('-') ? arg : resolveIfLocal(arg)));
}

/** Model alias or id. Empty means Claude Code's own default. */
export const CLAUDE_MODEL = (process.env.CLAUDE_MODEL ?? '').trim() || null;

/**
 * Claude Code's own directory: its login and nothing else of ours. Set on the
 * VPS so the app's Claude shares no settings, memory or MCP servers with
 * anyone's personal Claude. Never inside WIKI_ROOT.
 */
export const CLAUDE_CONFIG_DIR = absoluteOrNull(process.env.CLAUDE_CONFIG_DIR);

/**
 * A folder to keep the agent's raw event stream in, one file per run. Off unless
 * set. For finding out why a run went wrong, and for capturing the streams the
 * parser is tested against.
 *
 * What lands there is everything the agent read and wrote, document text
 * included. Never inside WIKI_ROOT, never left on in normal use.
 */
export function streamLogDir(): string | null {
  const dir = (process.env.CLAUDE_STREAM_LOG ?? '').trim();
  return dir ? path.resolve(APP_DIR, dir) : null;
}

/** Where the wiki rules are kept that every run is given. Which file, the layout of the wiki decides. */
export const PROMPTS_DIR = path.join(APP_DIR, 'prompts');

/** Dashboard-owned state. Deliberately outside any cluster so per-cluster git
 *  history stays a clean record of what the agent changed. */
export const DASHBOARD_DIR = path.join(WIKI_ROOT, '.dashboard');
export const JOBS_DIR = path.join(DASHBOARD_DIR, 'jobs');
export const STAGING_DIR = path.join(DASHBOARD_DIR, 'staging');
/** Proposed ingests awaiting a human decision. Dashboard state, not wiki
 *  content — which is why it lives here and not inside the cluster. */
export const PLANS_DIR = path.join(DASHBOARD_DIR, 'plans');
export const ORIGINALS_DIR = path.join(DASHBOARD_DIR, 'originals');
export const TRANSCRIPTS_DIR = path.join(DASHBOARD_DIR, 'transcripts');
/** What a person decided about each wiki, such as whether a filing waits for approval. See lib/settings.ts. */
export const SETTINGS_DIR = path.join(DASHBOARD_DIR, 'settings');
/** Conversations with each wiki, every question and answer. See lib/conversations.ts. */
export const CONVERSATIONS_DIR = path.join(DASHBOARD_DIR, 'conversations');

/** Hard ceiling on a single ingest before we give up and mark the job failed. */
export const INGEST_TIMEOUT_MS = Number(process.env.INGEST_TIMEOUT_MS ?? 15 * 60 * 1000);

/**
 * Planning gets its own budget. It reads the source and the existing wiki but
 * writes nothing, so it is the cheaper half — a single ceiling covering both
 * phases would let a slow plan eat the whole allowance for the write.
 */
export const PLAN_TIMEOUT_MS = Number(process.env.PLAN_TIMEOUT_MS ?? 10 * 60 * 1000);

/** One question, one answer. A question that writes gets the budget of a filing. */
export const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 5 * 60 * 1000);

const CLUSTER_NAME = /^[a-z0-9_-]+$/;

/**
 * Every endpoint that takes a cluster name calls this BEFORE touching the
 * filesystem. Without it, `../../etc` is a valid cluster name and WIKI_PATH
 * stops being a boundary.
 */
export function assertClusterName(name: unknown): string {
  if (typeof name !== 'string' || !CLUSTER_NAME.test(name)) {
    throw new HttpError(400, 'Cluster name must match /^[a-z0-9_-]+$/');
  }
  return name;
}

/** Resolve a path inside a cluster, refusing anything that escapes it. */
export function clusterPath(cluster: string, ...rest: string[]): string {
  const root = path.join(WIKI_ROOT, assertClusterName(cluster));
  const full = path.resolve(root, ...rest);
  // Belt and braces: even with a validated cluster name, a crafted page slug
  // could contain traversal segments.
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(400, 'Path escapes its cluster');
  }
  return full;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function absoluteOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? path.resolve(APP_DIR, trimmed) : null;
}

/** `scripts/fake-claude.mjs` -> absolute, when it exists under the app. Commands on PATH are left alone. */
function resolveIfLocal(value: string): string {
  if (path.isAbsolute(value)) return value;
  if (!value.includes('/') && !value.includes('\\')) return value;
  const candidate = path.resolve(APP_DIR, value);
  return existsSync(candidate) ? candidate : value;
}
