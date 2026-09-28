import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clusterPath } from './config';

const exec = promisify(execFile);

/**
 * Git is not the file manager here.
 *
 * Creating, moving and deleting staged uploads, plans and job records is plain
 * `fs` — those are dashboard bookkeeping, they live outside the cluster, and
 * they are never tracked. Git has exactly one job: a restore point for what the
 * agent wrote.
 *
 * That matters because execution is one unattended `--yolo` pass over a
 * document we did not write. If it mangles index.md and six pages, `fs` offers
 * no undo. A commit per executed ingest turns that into `git revert`.
 *
 * Until now the only commit in the codebase was "Create cluster" at init, so a
 * rollback meant discarding every ingest ever made.
 */

const IDENTITY = [
  '-c',
  'user.email=dashboard@localhost',
  '-c',
  'user.name=Dashboard',
];

/**
 * Commit whatever the agent just changed. Returns the short sha, or null if
 * there was nothing to commit or git is unavailable.
 *
 * Never throws. A cluster whose `git init` failed at creation still ingests
 * correctly; it just has no rollback, which is the same bargain createCluster
 * already makes.
 */
export async function commitCluster(cluster: string, message: string): Promise<string | null> {
  const cwd = clusterPath(cluster);
  try {
    await exec('git', ['add', '-A'], { cwd });

    // `git commit` exits non-zero when the index is clean. An execution that
    // changed nothing is a real outcome — the post-ingest check reports it —
    // and it is not a commit failure.
    const status = await exec('git', ['status', '--porcelain'], { cwd });
    if (!status.stdout.trim()) return null;

    await exec('git', [...IDENTITY, 'commit', '-m', message], { cwd });
    const { stdout } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim() || null;
  } catch (err) {
    console.error(`[git] commit failed for ${cluster} — this ingest has no rollback point`, err);
    return null;
  }
}
