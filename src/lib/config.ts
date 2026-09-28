import path from 'node:path';

/**
 * All filesystem and process configuration lives here. Nothing else in the app
 * reads process.env directly.
 */

export const WIKI_ROOT = process.env.WIKI_ROOT ?? path.join(process.cwd(), '.wiki-dev');

/**
 * The spawn seam. On the VPS this is the real binary; locally it is
 * scripts/fake-hermes.sh, which echoes canned output so the whole UI can be
 * built with no API spend and no client documents on the dev machine.
 */
export const HERMES_CMD = process.env.HERMES_CMD ?? 'node';

/**
 * Args placed before the ones we generate. Exists so the local fake can be
 * `node scripts/fake-hermes.mjs` — a shell script would not run on a Windows
 * dev machine, and the whole point of the seam is that it works on both.
 */
export const HERMES_ARGS = (process.env.HERMES_ARGS ?? 'scripts/fake-hermes.mjs')
  .split(' ')
  .filter(Boolean);

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

/** Hard ceiling on a single ingest before we give up and mark the job failed. */
export const INGEST_TIMEOUT_MS = Number(process.env.INGEST_TIMEOUT_MS ?? 15 * 60 * 1000);

/**
 * Planning gets its own budget. It reads the source and the existing wiki but
 * writes nothing, so it is the cheaper half — a single ceiling covering both
 * phases would let a slow plan eat the whole allowance for the write.
 */
export const PLAN_TIMEOUT_MS = Number(process.env.PLAN_TIMEOUT_MS ?? 10 * 60 * 1000);

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
