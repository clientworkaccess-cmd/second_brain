import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clusterPath } from './config';
import { PAGE_DIRS } from './wiki';

/**
 * A throwaway copy of a cluster, for the planning pass.
 *
 * The planning prompt tells the agent not to write anything. That instruction
 * is worth having and is worth nothing on its own: every spawn carries
 * `--yolo`, which README.md describes as "unrestricted shell over documents we
 * did not write", and the post-ingest check in lint.ts exists precisely because
 * natural-language instructions are followed probabilistically.
 *
 * So the planner does not get told to keep its hands off the wiki. It gets a
 * copy, and we delete it. If it writes — because the document told it to, or
 * because the skill's ingest procedure fired on its own — it writes into a
 * temporary directory that nothing ever reads.
 *
 * Two placement rules:
 *
 *  - The copy lives in os.tmpdir(), never under WIKI_ROOT. listClusters() is a
 *    readdir of WIKI_ROOT filtered on "has an index.md", so a cluster copy
 *    parked there would appear in the sidebar as a real cluster.
 *  - Only what the planner reads gets copied. Not .git, and not raw/, which
 *    holds every document ever ingested and would be duplicated on every plan
 *    and every revision.
 */

/** What the planner needs to reason about a cluster: scope, catalog, history. */
const COPIED_FILES = ['SCHEMA.md', 'index.md', 'log.md'];

export interface Sandbox {
  /** The copied cluster — pass as WIKI_PATH. */
  clusterDir: string;
  /** The copied cluster's parent — pass as WIKI_ROOT. */
  root: string;
  /** Where the staged source was placed, relative to clusterDir. */
  sourceRelPath: string;
  dispose: () => Promise<void>;
}

/**
 * Build the sandbox. `sourceFile` is the staged upload, copied in so the agent
 * can read it at a path inside its own working directory.
 */
export async function planningSandbox(cluster: string, sourceFile: string): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-plan-'));
  const clusterDir = path.join(root, cluster);
  const from = clusterPath(cluster);

  await fs.mkdir(clusterDir, { recursive: true });

  for (const name of COPIED_FILES) {
    await fs.copyFile(path.join(from, name), path.join(clusterDir, name)).catch(() => {
      /* a cluster that has never been ingested into may not have all three */
    });
  }

  for (const dir of PAGE_DIRS) {
    await fs
      .cp(path.join(from, dir), path.join(clusterDir, dir), { recursive: true })
      .catch(() => {
        /* the agent may not have scaffolded every directory yet */
      });
  }

  // The source document, placed inside the sandbox so the prompt can reference
  // a path the agent can actually open.
  const sourceRelPath = `source/${path.basename(sourceFile)}`;
  await fs.mkdir(path.join(clusterDir, 'source'), { recursive: true });
  await fs.copyFile(sourceFile, path.join(clusterDir, sourceRelPath));

  return {
    clusterDir,
    root,
    sourceRelPath,
    dispose: async () => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {
        /* a leaked temp dir is the OS's problem, not a reason to fail an ingest */
      });
    },
  };
}
