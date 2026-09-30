import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clusterPath } from './config';
import { isPageFolder, type Layout } from './layout';

/**
 * A throwaway copy of a wiki, for the planning pass.
 *
 * The planning prompt tells the agent not to write anything. That instruction
 * is worth having and is worth nothing on its own: the post-ingest check in
 * lint.ts exists precisely because natural-language instructions are followed
 * probabilistically. The planner's tool profile (claude.ts) allows it to write
 * one file, its plan; this copy is the second layer under that rule.
 *
 * So the planner does not get told to keep its hands off the wiki. It gets a
 * copy, and we delete it. If it writes — because the document told it to, or
 * because it started filing on its own — it writes into a
 * temporary directory that nothing ever reads.
 *
 * Two placement rules:
 *
 *  - The copy lives in os.tmpdir(), never under WIKI_ROOT. listClusters() is a
 *    readdir of WIKI_ROOT, so a copy parked there would appear in the sidebar
 *    as a wiki of its own.
 *  - Only what the planner reads gets copied: the rules and the pages. Not
 *    .git, and not the sources, which hold every document ever filed and would
 *    be duplicated on every plan and every revision.
 */

export interface Sandbox {
  /** The copied wiki: the agent's working directory for the planning run. */
  clusterDir: string;
  /** The copy's parent. Removed with everything in it when the run ends. */
  root: string;
  /** Where the staged source was placed, relative to clusterDir. */
  sourceRelPath: string;
  dispose: () => Promise<void>;
}

/**
 * Build the sandbox. `sourceFile` is the staged upload, copied in so the agent
 * can read it at a path inside its own working directory.
 */
export async function planningSandbox(cluster: string, sourceFile: string, layout: Layout): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-plan-'));
  const clusterDir = path.join(root, cluster);
  const from = clusterPath(cluster);

  await fs.mkdir(path.join(clusterDir, layout.pagesDir), { recursive: true });

  // The rules. A wiki that has never been filed into may not have them yet.
  await fs.copyFile(path.join(from, layout.rulesFile), path.join(clusterDir, layout.rulesFile)).catch(() => {});

  // The pages: what lies beside the index, and every folder of pages.
  const pagesFrom = path.join(from, layout.pagesDir);
  const pagesTo = path.join(clusterDir, layout.pagesDir);
  for (const entry of await fs.readdir(pagesFrom, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      await fs.copyFile(path.join(pagesFrom, entry.name), path.join(pagesTo, entry.name)).catch(() => {});
    } else if (entry.isDirectory() && isPageFolder(layout, entry.name)) {
      await fs.cp(path.join(pagesFrom, entry.name), path.join(pagesTo, entry.name), { recursive: true }).catch(() => {});
    }
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
