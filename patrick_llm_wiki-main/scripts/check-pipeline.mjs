#!/usr/bin/env node
/**
 * Drives the whole approve/reject/revise pipeline against a throwaway wiki,
 * through the real lib, and prints what happened at each gate.
 *
 *   npm run check:pipeline
 *
 * What it proves, in order:
 *  1. Upload stages the file OUTSIDE the cluster and writes nothing into it.
 *  2. A planning pass that actively misbehaves cannot touch the real cluster.
 *  3. Approve writes, commits, and moves the source into raw/.
 *  4. Reject deletes the staged file and the original, and leaves no wiki trace.
 *  5. Revise re-plans without writing.
 *  6. A plan made against a wiki that has since moved is refused.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

await compileLib();

/** Windows absolute paths are not valid ESM specifiers; file:// URLs are. */
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-'));
process.env.WIKI_ROOT = root;
process.env.HERMES_CMD = 'node';
process.env.HERMES_ARGS = 'scripts/fake-hermes.mjs';

const { createCluster } = await import(lib('clusters'));
const jobs = await import(lib('jobs'));
const { readPlan } = await import(lib('plans'));
const { STAGING_DIR, ORIGINALS_DIR, PLANS_DIR } = await import(lib('config'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const settle = (job) =>
  new Promise((resolve) => {
    const stop = jobs.subscribe(job.id, (j) => {
      if (!jobs.isActive(j.status)) {
        stop();
        resolve(j);
      }
    });
  });

const ls = async (dir) => fs.readdir(dir).catch(() => []);
const pageCount = async (cluster) => {
  let n = 0;
  for (const d of ['entities', 'concepts', 'comparisons', 'queries']) {
    n += (await ls(path.join(root, cluster, d))).filter((f) => f.endsWith('.md')).length;
  }
  return n;
};

async function stage(cluster, name, body, withOriginal = true) {
  await fs.mkdir(STAGING_DIR, { recursive: true });
  await fs.mkdir(ORIGINALS_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `${crypto.randomUUID()}__${name}`);
  await fs.writeFile(staged, body);
  let original = null;
  if (withOriginal) {
    original = path.join(ORIGINALS_DIR, `${crypto.randomUUID()}__${name.replace(/\.md$/, '.pdf')}`);
    await fs.writeFile(original, 'binary-ish');
  }
  return { staged, original };
}

const SOURCE = `---\nsource_url: x\ningested: 2026-09-16\nsha256: 0\n---\nThe warehouse team checks every returned item before we release the refund.\n`;

// ---------------------------------------------------------------------- 0
// Every flag the dashboard puts on Hermes's command line must be one the real
// binary actually has. A `--plan-file` invented here made the VPS exit 2 on the
// unknown option before it read a single document, and the UI reported that as
// a failed ingest — so this is a source check, not a behavioural one: the local
// fake happily accepts anything, which is exactly why it cannot catch this.
const KNOWN_FLAGS = new Set(['-z', '--yolo', '--usage-file']);
const hermesSrc = await fs.readFile(new URL('../src/lib/hermes.ts', import.meta.url), 'utf8');
const flags = [...hermesSrc.matchAll(/'(-{1,2}[a-z][a-z-]*)'/g)].map((m) => m[1]);
const invented = flags.filter((f) => !KNOWN_FLAGS.has(f));
check('no invented flags on the agent command line', invented.length === 0,
  invented.length ? `unknown: ${[...new Set(invented)].join(', ')}` : `only ${[...KNOWN_FLAGS].join(', ')}`);

// ---------------------------------------------------------------- 1 + 2 + 3
await createCluster({ name: 'ops', scope: 'Returns and refunds', entities: '', questions: '' });
const baselinePages = await pageCount('ops');
const indexBefore = await fs.readFile(path.join(root, 'ops', 'index.md'), 'utf8');

// The planning pass is told to misbehave: it tries to write pages and clobber
// index.md. The sandbox is the only thing standing between it and the cluster.
process.env.HERMES_ARGS = 'scripts/fake-hermes.mjs --skip sandbox';
let { staged, original } = await stage('ops', 'note.md', SOURCE);
let job = await jobs.startPlanning({ cluster: 'ops', filename: 'note.md', stagedPath: staged, originalPath: original });
job = await settle(job);

check('upload stages outside the cluster', (await ls(path.join(root, 'ops'))).includes('raw') === false,
  `cluster contains: ${(await ls(path.join(root, 'ops'))).join(', ')}`);
check('planning reaches awaiting_approval', job.status === 'awaiting_approval', job.status + (job.error ? ` (${job.error})` : ''));
check('a misbehaving planner cannot write pages', (await pageCount('ops')) === baselinePages,
  `${await pageCount('ops')} pages, expected ${baselinePages}`);
check('a misbehaving planner cannot clobber index.md',
  (await fs.readFile(path.join(root, 'ops', 'index.md'), 'utf8')) === indexBefore);
check('no planner leftovers in the cluster', !(await ls(path.join(root, 'ops'))).includes('source'));

const plan = await readPlan(job.id);
check('plan validates and is content-first', !!plan && plan.pages.length === 3 && plan.pages.every((p) => p.name && p.quote),
  plan ? `${plan.pages.length} pages, ${plan.decisions.length} decisions, ${plan.skipped.length} skipped` : 'no plan');

process.env.HERMES_ARGS = 'scripts/fake-hermes.mjs';
job = await jobs.approvePlan(job.id);
job = await settle(job);

check('approve executes and finishes', job.status === 'done' || job.status === 'attention',
  `${job.status}${job.lint ? ` findings=${job.lint.findings.map((f) => f.code).join(',') || 'none'}` : ''}`);
check('approve writes pages', (await pageCount('ops')) > baselinePages, `${await pageCount('ops')} pages`);
check('source moved into raw/', (await ls(path.join(root, 'ops', 'raw'))).some((f) => f.endsWith('note.md')));
check('staging is emptied on approve', !(await ls(STAGING_DIR)).length, `${(await ls(STAGING_DIR)).length} left`);
check('a commit was made', !!job.commit, job.commit ?? 'none');
check('plan is cleared after execution', !(await ls(PLANS_DIR)).length);

const log = execFileSync('git', ['log', '--oneline'], { cwd: path.join(root, 'ops'), encoding: 'utf8' });
check('git history has the ingest', log.includes('Ingest note.md'), log.trim().split('\n').join(' | '));

// ---------------------------------------------------------------------- 4
({ staged, original } = await stage('ops', 'reject-me.md', SOURCE));
let job2 = await jobs.startPlanning({ cluster: 'ops', filename: 'reject-me.md', stagedPath: staged, originalPath: original });
job2 = await settle(job2);
const pagesBeforeReject = await pageCount('ops');
const rejectedOriginal = path.basename(original);
job2 = await jobs.rejectPlan(job2.id);

check('reject ends as rejected', job2.status === 'rejected', job2.status);
check('reject deletes the staged file', !(await ls(STAGING_DIR)).length);
// Only this job's original goes. The approved job's original is the archive
// and must survive — originals/ is what "keep the source we were given" means.
check('reject deletes its own archived original', !(await ls(ORIGINALS_DIR)).includes(rejectedOriginal),
  `remaining: ${(await ls(ORIGINALS_DIR)).join(', ') || 'none'}`);
check('reject leaves the approved job’s original alone', (await ls(ORIGINALS_DIR)).length === 1,
  `${(await ls(ORIGINALS_DIR)).length} archived`);
check('reject deletes the plan', !(await ls(PLANS_DIR)).length);
check('reject writes nothing to the wiki', (await pageCount('ops')) === pagesBeforeReject);
check('reject keeps the job record for the trail', !!(await jobs.getJob(job2.id)));

// ---------------------------------------------------------------------- 5
({ staged, original } = await stage('ops', 'revise-me.md', SOURCE));
let job3 = await jobs.startPlanning({ cluster: 'ops', filename: 'revise-me.md', stagedPath: staged, originalPath: original });
job3 = await settle(job3);
const pagesBeforeRevise = await pageCount('ops');
job3 = await jobs.revisePlan(job3.id, 'Fold Stripe into Payment Gateway.');
job3 = await settle(job3);
const revised = await readPlan(job3.id);

check('revise re-plans', job3.status === 'awaiting_approval' && job3.revision === 2, `${job3.status} rev${job3.revision}`);
check('revise records the feedback', revised?.feedback === 'Fold Stripe into Payment Gateway.', revised?.feedback ?? 'none');
check('revise writes nothing to the wiki', (await pageCount('ops')) === pagesBeforeRevise);

// ---------------------------------------------------------------------- 6
// The wiki moves underneath the pending plan. Approving it now would write
// against a state the agent never saw.
await fs.writeFile(path.join(root, 'ops', 'entities', 'surprise.md'), '# Surprise\nAdded behind the plan.\n');
let stale = null;
try {
  await jobs.approvePlan(job3.id);
} catch (err) {
  stale = err;
}
check('a stale plan is refused', stale?.status === 409, stale ? `${stale.status}: ${stale.message}` : 'it executed anyway');

await fs.rm(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
