import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError, clusterPath } from './config';
import { exists } from './files';
import type { Layout } from './layout';

const exec = promisify(execFile);

/**
 * Git is not the file manager here.
 *
 * Creating, moving and deleting staged uploads, plans and job records is plain
 * `fs` — those are dashboard bookkeeping, they live outside the cluster, and
 * they are never tracked. Git has exactly one job: a restore point for what the
 * agent wrote.
 *
 * That matters because execution is one unattended pass over a document we
 * did not write. If it mangles the index and six pages, `fs` offers
 * no undo. A commit per executed ingest turns that into `git revert`.
 */

const IDENTITY = [
  '-c',
  'user.email=brain-app@localhost',
  '-c',
  'user.name=Second Brain',
];

/**
 * The wiki's own repository, made if it has none.
 *
 * A wiki this app created has one from the start. One that was brought here
 * may not. Without its own, git would go looking in the folders above and
 * commit into whatever repository it found there, so no git command is run
 * in a wiki before this has answered yes.
 *
 * A wiki that arrives without history gets a first commit of what it holds, so
 * that the first filing has something to be compared with.
 */
export async function ensureRepo(cluster: string, layout: Layout): Promise<boolean> {
  const cwd = clusterPath(cluster);
  if (await exists(path.join(cwd, '.git'))) return true;
  try {
    await exec('git', ['init'], { cwd });
    if (await stage(cwd, layout)) {
      await exec('git', [...IDENTITY, 'commit', '-m', 'The wiki as it was before the first filing here'], { cwd });
    }
    return true;
  } catch (err) {
    console.error(`[git] could not make a repository for ${cluster}; filings there have no restore point`, err);
    return exists(path.join(cwd, '.git'));
  }
}

/** Stage what the layout says is the wiki. True when that leaves something to commit. */
async function stage(cwd: string, layout: Layout): Promise<boolean> {
  if (layout.tracked.length === 0) {
    await exec('git', ['add', '-A'], { cwd });
  } else {
    const there: string[] = [];
    for (const name of layout.tracked) if (await exists(path.join(cwd, name))) there.push(name);
    if (there.length === 0) return false;
    await exec('git', ['add', '-A', '--', ...there], { cwd });
  }
  // Exit code 1 means the index differs from the last commit.
  return exec('git', ['diff', '--cached', '--quiet'], { cwd }).then(
    () => false,
    () => true,
  );
}

/**
 * Commit whatever the agent just changed. Returns the short sha, or null if
 * there was nothing to commit or git is unavailable.
 *
 * Never throws. A wiki without a repository still takes filings; it just has
 * no restore point.
 */
export async function commitCluster(cluster: string, message: string, layout: Layout): Promise<string | null> {
  const cwd = clusterPath(cluster);
  try {
    if (!(await ensureRepo(cluster, layout))) return null;

    // A filing that changed nothing is a real outcome — the check after filing
    // reports it — and it is not a commit failure.
    if (!(await stage(cwd, layout))) return null;

    await exec('git', [...IDENTITY, 'commit', '-m', message], { cwd });
    const { stdout } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim() || null;
  } catch (err) {
    console.error(`[git] commit failed for ${cluster} — this ingest has no rollback point`, err);
    return null;
  }
}

/**
 * Take a filing back out: a new commit that undoes the one given. Returns the
 * short sha of that commit.
 *
 * Throws, with a message a reader can act on, when the revert does not apply
 * cleanly, which is what happens when a later filing changed the same pages.
 * Nothing is left half done: the revert is abandoned and the wiki is as it was.
 */
export async function revertCommit(cluster: string, sha: string, message: string, layout: Layout): Promise<string> {
  const cwd = clusterPath(cluster);
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new HttpError(400, 'That is not a commit');
  if (!(await ensureRepo(cluster, layout))) throw new HttpError(409, 'This wiki has no repository, so there is nothing to revert');

  // Anything a person left uncommitted in the folder would be swept up by
  // the revert's commit. Stage what the layout says is the wiki first, as a
  // filing does, so that the revert starts from a clean index.
  if (await stage(cwd, layout)) {
    await exec('git', [...IDENTITY, 'commit', '-m', 'Changes made outside the app, before an undo'], { cwd });
  }

  try {
    await exec('git', ['revert', '--no-commit', sha], { cwd });
    await exec('git', [...IDENTITY, 'commit', '-m', message], { cwd });
  } catch (err) {
    await exec('git', ['revert', '--abort'], { cwd }).catch(() => {});
    const said = err instanceof Error ? err.message : String(err);
    if (/conflict/i.test(said)) {
      throw new HttpError(409, 'A later filing changed the same pages, so this one cannot be undone on its own. Undo the later one first.');
    }
    throw new HttpError(500, `The revert did not apply: ${said.split('\n').find((line) => line.trim())?.slice(0, 200) ?? 'git failed'}`);
  }
  const { stdout } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  return stdout.trim();
}
