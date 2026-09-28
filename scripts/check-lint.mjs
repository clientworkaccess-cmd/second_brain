#!/usr/bin/env node
/**
 * Drives one ingest through the real job pipeline against a throwaway wiki and
 * prints the job's final status and lint findings. Pass a skip list to make the
 * fake agent misbehave and exercise the failure paths:
 *
 *   npm run check:lint             -> done, no findings
 *   npm run check:lint -- index    -> attention (index-not-updated is an error)
 *   npm run check:lint -- log      -> done, with a log-not-updated warning
 *
 * compile-lib.mjs builds src/lib to plain ESM first, because the app's TS
 * imports are extensionless — Next resolves those, Node does not. That step
 * used to live only in a pull request description, which stopped existing the
 * moment the PR merged.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-lint-'));
process.env.WIKI_ROOT = root;
const skip = process.argv[2] ?? '';
process.env.HERMES_CMD = 'node';
process.env.HERMES_ARGS = skip ? `scripts/fake-hermes.mjs --skip ${skip}` : 'scripts/fake-hermes.mjs';

const { createCluster } = await import(lib('clusters'));
const { startPlanning, approvePlan, getJob, subscribe, isActive } = await import(lib('jobs'));
const { STAGING_DIR } = await import(lib('config'));

await createCluster({ name: 'ops', scope: 'Returns and refunds', entities: '', questions: '' });
await fs.mkdir(STAGING_DIR, { recursive: true });
const staged = path.join(STAGING_DIR, `${crypto.randomUUID()}__note.md`);
await fs.writeFile(staged, '---\nsource_url: x\ningested: 2026-09-16\nsha256: 0\n---\nA note about the warehouse team and the returns portal.\n');

const settle = (job) =>
  new Promise((resolve) => {
    const stop = subscribe(job.id, (j) => isActive(j.status) || (stop(), resolve(j)));
  });

// The check runs on what execution wrote, so drive the gate: plan, approve,
// then look at the disk. The --skip flags only bite during execution.
let job = await startPlanning({ cluster: 'ops', filename: 'note.md', stagedPath: staged, originalPath: null });
await settle(job);
job = await approvePlan(job.id);
await settle(job);
const final = await getJob(job.id);
console.log(JSON.stringify({ skip, status: final.status, diff: final.diff, findings: final.lint?.findings.map((f) => `${f.severity}:${f.code}`) }, null, 1));
await fs.rm(root, { recursive: true, force: true });
