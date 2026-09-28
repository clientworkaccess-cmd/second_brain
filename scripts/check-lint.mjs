#!/usr/bin/env node
/**
 * The check that runs after every filing, held against an agent that does its
 * job and against one that does not.
 *
 *   npm run check:lint                  every case below, pass or fail
 *   npm run check:lint -- --skip index  one case, printed in full
 *
 * | the agent…                       | the job ends as | because                       |
 * |----------------------------------|-----------------|-------------------------------|
 * | does everything                  | done            | nothing to report             |
 * | leaves index.md alone            | attention       | index-not-updated is an error |
 * | leaves log.md alone              | done            | log-not-updated is a warning  |
 * | changes SCHEMA.md                | attention       | schema-changed is an error    |
 * | changes the source it was given  | attention       | source-changed is an error    |
 *
 * Each case drives one document through the real job pipeline, in a throwaway
 * wiki of its own. The last two are things the real binary is refused. The
 * stand-in does them anyway, which is how the check is shown to notice if that
 * refusal ever stops holding.
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
process.env.CLAUDE_CMD = 'node';
process.env.CLAUDE_ARGS = 'scripts/fake-claude.mjs';

const { createCluster } = await import(lib('clusters'));
const { startPlanning, approvePlan, getJob, subscribe, isActive } = await import(lib('jobs'));
const { STAGING_DIR } = await import(lib('config'));

const settle = (job) =>
  new Promise((resolve) => {
    const stop = subscribe(job.id, (j) => isActive(j.status) || (stop(), resolve(j)));
  });

let cases = 0;

/** One document, planned, approved and filed by an agent told how to misbehave. */
async function run(switches = '') {
  const cluster = `case-${++cases}`;
  await createCluster({ name: cluster, scope: 'Returns and refunds', entities: '', questions: '' });
  await fs.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `${crypto.randomUUID()}__note.md`);
  await fs.writeFile(staged, '---\nsource_url: x\ningested: 2026-09-16\nsha256: 0\n---\nA note about the warehouse team and the returns portal.\n');

  // The check runs on what execution wrote, so drive the gate: plan, approve,
  // then look at the disk. The switches only bite during execution, and the
  // command line is read when a run starts, so it can change between cases.
  process.env.CLAUDE_ARGS = `scripts/fake-claude.mjs ${switches}`.trim();
  let job = await startPlanning({ cluster, filename: 'note.md', stagedPath: staged, originalPath: null });
  await settle(job);
  job = await approvePlan(job.id);
  await settle(job);
  const final = await getJob(job.id);
  return {
    switches,
    cluster,
    status: final.status,
    error: final.error ?? null,
    diff: final.diff,
    findings: (final.lint?.findings ?? []).map((f) => `${f.severity}:${f.code}`),
    details: (final.lint?.findings ?? []).map((f) => f.detail),
  };
}

const only = process.argv.slice(2).join(' ');
if (only) {
  console.log(JSON.stringify(await run(only), null, 1));
  await fs.rm(root, { recursive: true, force: true });
  process.exit(0);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const describe = (r) => `${r.status}${r.error ? ` (${r.error})` : ''}, findings: ${r.findings.join(', ') || 'none'}`;

const clean = await run();
check('a complete filing ends as done', clean.status === 'done', describe(clean));
check('a complete filing has nothing to report', clean.findings.length === 0, describe(clean));
check('a complete filing counts what it added', clean.diff?.newPages === 3, JSON.stringify(clean.diff));
const written = await fs.readFile(path.join(root, clean.cluster, 'entities', 'warehouse-team.md'), 'utf8');
check('pages carry the block the wiki rules ask for', /^---\ntitle: Warehouse Team\n[\s\S]*?\ntype: entity\n[\s\S]*?\nsources: \[raw\/note\.md\]\n[\s\S]*?\n---\n\n# Warehouse Team\n/.test(written), written.split('\n').slice(0, 9).join(' | '));

const noIndex = await run('--skip index');
check('an untouched index needs attention', noIndex.status === 'attention', describe(noIndex));
check('an untouched index is an error', noIndex.findings.includes('error:index-not-updated'), describe(noIndex));
check('pages missing from the index are listed', noIndex.findings.filter((f) => f === 'warning:index-missing-page').length === 3, describe(noIndex));

const noLog = await run('--skip log');
check('an untouched log still ends as done', noLog.status === 'done', describe(noLog));
check('an untouched log is a warning', noLog.findings.includes('warning:log-not-updated'), describe(noLog));

const schema = await run('--touch schema');
check('a changed SCHEMA.md needs attention', schema.status === 'attention', describe(schema));
check('a changed SCHEMA.md is an error, and the only finding', schema.findings.join() === 'error:schema-changed', describe(schema));

const source = await run('--touch source');
check('a changed source needs attention', source.status === 'attention', describe(source));
check('a changed source is an error, and the only finding', source.findings.join() === 'error:source-changed', describe(source));
check('the finding names the file', source.details.some((d) => d.includes('"raw/note.md" was changed')), source.details.join(' '));

await fs.rm(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
