import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HttpError,
  JOBS_DIR,
  INGEST_TIMEOUT_MS,
  PLAN_TIMEOUT_MS,
  clusterPath,
} from './config';
import { ensureDashboardDirs, readIfPresent } from './clusters';
import { agentFailure, runClaude } from './claude';
import { indexFile, layoutOf, logFile, type Layout } from './layout';
import { diffAgainst, loadWiki, snapshot, type IngestDiff } from './wiki';
import type { Facet } from './facets';
import { beforeIngest, lintAfterIngest, sourceFingerprints, type LintResult } from './lint';
import { planningSandbox } from './sandbox';
import { commitCluster, ensureRepo, revertCommit } from './git';
import { readSettings } from './settings';
import { audit } from './audit';
import {
  basisIsStale,
  deletePlan,
  extractJson,
  linkFor,
  pathFor,
  readPlan,
  slugFor,
  toBasis,
  validatePlan,
  writePlan,
  type Plan,
} from './plans';

/**
 * Ingest job state.
 *
 * An ingest is two agent runs with a human between them:
 *
 *   planning -> awaiting_approval -> executing -> done | attention
 *
 * The middle state is the product. Until someone approves, the source document
 * sits in .dashboard/staging/ and the cluster has not been touched — the
 * planning pass runs against a throwaway copy (see sandbox.ts), so "read-only"
 * is a property of where the agent is pointed rather than a sentence in its
 * prompt.
 *
 * Two things follow from the human gap that did not apply to the old
 * single-shot flow:
 *
 *  1. The per-cluster busy lock is taken for execution only. Holding it across
 *     the review would let anyone who closes a tab lock a cluster until the
 *     next restart — there is no lock timeout. Releasing it instead means two
 *     plans can be approved against one cluster, which is what the staleness
 *     check on Plan.basis is for: a plan made against a wiki that has since
 *     moved is refused, not executed blind.
 *  2. A restart must not destroy a pending plan. reconcileOnBoot only kills
 *     states that had a live process behind them; awaiting_approval had none,
 *     so it survives, which is the entire point of the gate.
 */

export type JobStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'done'
  | 'attention'
  | 'rejected'
  | 'failed'
  | 'interrupted'
  | 'undone';

/** States with a live agent process behind them. */
const ACTIVE: JobStatus[] = ['planning', 'executing'];

/** States nothing further will happen to on its own. */
const FINAL: JobStatus[] = ['done', 'attention', 'rejected', 'failed', 'interrupted', 'undone'];

export function isActive(status: JobStatus): boolean {
  return ACTIVE.includes(status);
}

export function isFinal(status: JobStatus): boolean {
  return FINAL.includes(status);
}

export interface Job {
  id: string;
  cluster: string;
  filename: string;
  status: JobStatus;
  startedAt: string;
  endedAt: string | null;
  lines: string[];
  diff: IngestDiff | null;
  /** What the post-ingest check found on disk. Null until execution finishes. */
  lint: LintResult | null;
  /** Short sha of the commit that captured this ingest, when there was one. */
  commit: string | null;
  /** The staged upload, absolute. Deleted on reject, moved into raw/ on approve. */
  stagedPath: string | null;
  /** The archived original binary, absolute. Recorded so reject can remove it. */
  originalPath: string | null;
  /** Bumped by each revision, so the UI can say "plan 2". */
  revision: number;
  /** True when the plan was carried out as soon as it was made, because the wiki is set to file at once. */
  automatic: boolean;
  /** Short sha of the commit that undid this filing, when it was undone. */
  undoCommit: string | null;
  error: string | null;
}

/**
 * Shared in-process state, deliberately hung off globalThis.
 *
 * Next does not guarantee one module instance per process. Route handlers are
 * compiled into separate bundles, so `/api/upload` and `/api/jobs/[id]` can
 * each get their own copy of this module — and with a plain `const listeners`,
 * the SSE route subscribes to one Map while the ingest emits into another.
 * Verified in dev: subscribe() registered a listener and the very next emit()
 * still reported an empty map, so no progress event ever reached the browser
 * and the panel sat on its spinner until the page was reloaded by hand.
 *
 * That mattered little when a finished ingest was the only thing worth
 * waiting for. It matters now: the panel has to advance to the approval gate on
 * its own, or the human in the middle never gets asked.
 *
 * globalThis is per-process, so this is exactly as durable as before — the disk
 * is still the real record. It only makes the fast path actually shared.
 */
interface JobRuntime {
  /** cluster → the job currently writing to it. Held during execution only. */
  busy: Map<string, string>;
  /** Live subscribers, for SSE. Disk is the durable copy; this is the fast path. */
  listeners: Map<string, Set<(job: Job) => void>>;
  cache: Map<string, Job>;
}

const globalForJobs = globalThis as typeof globalThis & { __wikiJobs?: JobRuntime };

const runtime: JobRuntime = (globalForJobs.__wikiJobs ??= {
  busy: new Map(),
  listeners: new Map(),
  cache: new Map(),
});

const { busy, listeners, cache } = runtime;

export function isBusy(cluster: string): string | null {
  return busy.get(cluster) ?? null;
}

/**
 * A restart kills any spawned agent with it, so a job still marked planning or
 * executing on boot is dead. Mark those so the UI can say "interrupted" instead
 * of streaming a progress bar that will never move.
 *
 * awaiting_approval is deliberately absent from that list. Nothing was running,
 * the plan is on disk, and deploys here are routine — reconciling it would mean
 * every push silently threw away whatever was waiting for review.
 */
export async function reconcileOnBoot(): Promise<void> {
  await ensureDashboardDirs();
  let files: string[] = [];
  try {
    files = await fs.readdir(JOBS_DIR);
  } catch {
    return;
  }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const job = await readJobFile(path.join(JOBS_DIR, file));
    if (job && isActive(job.status)) {
      const was = job.status;
      job.status = 'interrupted';
      job.endedAt = new Date().toISOString();
      job.error =
        was === 'planning'
          ? 'The server restarted while this document was being read. Upload it again.'
          : 'The server restarted while this ingest was running. Re-upload the file.';
      await persist(job);
    }
  }
}

export async function getJob(id: string): Promise<Job | null> {
  if (cache.has(id)) return cache.get(id)!;
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new HttpError(400, 'Malformed job id');

  // Cache what comes off disk. The decision handlers mutate the job they are
  // given and hand it to a long-running pass, so two cold reads returning two
  // detached objects for the same id would let one silently overwrite the
  // other's progress. After a restart every job is a cold read, which is
  // exactly when a pending plan gets approved.
  const job = await readJobFile(path.join(JOBS_DIR, `${id}.json`));
  if (job) cache.set(job.id, job);
  return job;
}

/**
 * The filings of one wiki, newest first: every job that was ever started for
 * it, whatever became of it. Read from disk each time; a job that is under
 * way is taken from memory, where its progress is.
 */
export async function listJobs(cluster: string, limit = 50): Promise<Job[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue;
    const id = file.slice(0, -5);
    const job = cache.get(id) ?? (await readJobFile(path.join(JOBS_DIR, file)));
    if (job && job.cluster === cluster) jobs.push(job);
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

export function subscribe(id: string, fn: (job: Job) => void): () => void {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(fn);
  return () => listeners.get(id)?.delete(fn);
}

/**
 * Stage 1→2. The upload is on disk in .dashboard/staging/; read it and propose
 * a plan. Returns immediately with the job id; the work continues after.
 */
export async function startPlanning(opts: {
  cluster: string;
  filename: string;
  stagedPath: string;
  originalPath: string | null;
}): Promise<Job> {
  const job: Job = {
    id: randomUUID(),
    cluster: opts.cluster,
    filename: opts.filename,
    status: 'planning',
    startedAt: new Date().toISOString(),
    endedAt: null,
    lines: [],
    diff: null,
    lint: null,
    commit: null,
    stagedPath: opts.stagedPath,
    originalPath: opts.originalPath,
    revision: 1,
    automatic: false,
    undoCommit: null,
    error: null,
  };

  cache.set(job.id, job);
  await persist(job);

  // Deliberately not awaited. The HTTP response goes out now.
  void plan(job, null);

  return job;
}

/**
 * Stage 3, "Revise". Re-plan the same staged document with the founder's
 * correction in hand. No lock: nothing has been written yet.
 */
export async function revisePlan(jobId: string, feedback: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job) throw new HttpError(404, 'No such job');
  if (job.status !== 'awaiting_approval') {
    throw new HttpError(409, `This ingest is ${job.status}, not waiting for a decision`);
  }
  if (!job.stagedPath) throw new HttpError(409, 'The staged document for this ingest is gone');

  const previous = await readPlan(jobId);

  job.status = 'planning';
  job.revision += 1;
  job.lines = [];
  job.error = null;
  job.endedAt = null;
  await persist(job);
  emit(job);

  void plan(job, { feedback, previous });

  return job;
}

/**
 * Stage 3, "Reject". Nothing was written, so there is nothing to revert — this
 * is plain fs cleanup. The job record survives as the trail that someone looked
 * at this document and said no.
 */
export async function rejectPlan(jobId: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job) throw new HttpError(404, 'No such job');
  if (job.status !== 'awaiting_approval') {
    throw new HttpError(409, `This ingest is ${job.status}, not waiting for a decision`);
  }

  await deletePlan(jobId);
  // Both of these accumulate forever otherwise — the staged markdown and the
  // archived original. Nothing references them once the plan is gone.
  if (job.stagedPath) await fs.rm(job.stagedPath, { force: true });
  if (job.originalPath) await fs.rm(job.originalPath, { force: true });

  job.stagedPath = null;
  job.originalPath = null;
  job.status = 'rejected';
  job.endedAt = new Date().toISOString();
  await persist(job);
  emit(job);

  return job;
}

/**
 * Stage 3→4, "Approve". This is the first moment anything enters the cluster.
 */
export async function approvePlan(jobId: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job) throw new HttpError(404, 'No such job');
  if (job.status !== 'awaiting_approval') {
    throw new HttpError(409, `This ingest is ${job.status}, not waiting for a decision`);
  }
  if (!job.stagedPath) throw new HttpError(409, 'The staged document for this ingest is gone');

  const approved = await readPlan(jobId);
  if (!approved) {
    throw new HttpError(422, 'The plan for this ingest is missing or unreadable. Create a new one.');
  }

  await startExecution(job, approved);
  return job;
}

/**
 * Claim the wiki, check that the plan still describes it, and start writing.
 * Shared by approval and by the automatic path.
 */
async function startExecution(job: Job, approved: Plan): Promise<void> {
  // Claim the cluster before the first await, not after the checks.
  // `snapshot()` below yields, and anything that yields between testing the
  // lock and taking it is not a lock: two clicks, or two tabs, would both read
  // it free and both start writing. Released again on every path that refuses.
  const held = busy.get(job.cluster);
  if (held && held !== job.id) {
    throw new HttpError(409, 'This cluster is already being written to. Wait for it to finish.');
  }
  busy.set(job.cluster, job.id);

  try {
    // The plan describes a wiki as it looked when the plan was made. If another
    // ingest landed in between, executing it would write against a state the
    // agent never saw — silently overwriting whatever the other one did.
    const now = await snapshot(job.cluster);
    if (basisIsStale(approved.basis, now)) {
      throw new HttpError(
        409,
        'The wiki changed since this plan was made. Create a new plan so it reflects what is there now.',
      );
    }
  } catch (err) {
    busy.delete(job.cluster);
    throw err;
  }

  job.status = 'executing';
  job.lines = [];
  job.error = null;
  await persist(job);
  emit(job);

  void execute(job, approved);
}

/**
 * "Undo". The commit that captured a filing is reverted, which takes the pages
 * it wrote and the source it filed back out. A later filing that touched the
 * same pages makes that impossible to do cleanly, and then nothing is changed.
 */
export async function undoFiling(jobId: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job) throw new HttpError(404, 'No such job');
  if (job.status !== 'done' && job.status !== 'attention') {
    throw new HttpError(409, `This ingest is ${job.status}, not filed`);
  }
  if (!job.commit) throw new HttpError(409, 'This filing was not committed, so there is nothing to revert. Restore the pages by hand.');

  const held = busy.get(job.cluster);
  if (held && held !== job.id) {
    throw new HttpError(409, 'This cluster is already being written to. Wait for it to finish.');
  }
  busy.set(job.cluster, job.id);
  try {
    const layout = await layoutOf(job.cluster);
    job.undoCommit = await revertCommit(job.cluster, job.commit, `Undo the filing of ${job.filename}`, layout);
    job.status = 'undone';
    job.endedAt = new Date().toISOString();
    await persist(job);
    emit(job);
    // The wiki moved; whatever was read of it is read again.
    await snapshot(job.cluster);
  } finally {
    busy.delete(job.cluster);
  }
  return job;
}

/** The planning pass. Runs against a copy; the live cluster is not reachable. */
async function plan(
  job: Job,
  revision: { feedback: string; previous: Plan | null } | null,
): Promise<void> {
  let sandbox: Awaited<ReturnType<typeof planningSandbox>> | null = null;
  try {
    if (!job.stagedPath) throw new Error('The staged document for this ingest is gone');

    const layout = await layoutOf(job.cluster);
    const { facets } = await loadWiki(job.cluster);

    // Captured from the live cluster, not the copy — this is what approval is
    // checked against later.
    const basis = toBasis(await snapshot(job.cluster));

    sandbox = await planningSandbox(job.cluster, job.stagedPath, layout);

    // Inside the sandbox's cluster directory, which is the agent's working
    // directory — and the one file in it the planner is allowed to write (see
    // the plan profile in claude.ts). The prompt names the path; nothing is
    // added to the command line for the agent to write a file.
    const planFile = path.join(sandbox.clusterDir, 'plan.json');

    const run = runClaude({
      mode: 'plan',
      prompt: planPrompt(job, layout, facets, sandbox.sourceRelPath, planFile, revision),
      cwd: sandbox.clusterDir,
      layout,
      timeoutMs: PLAN_TIMEOUT_MS,
    });

    for await (const line of run.lines) {
      if (!line.trim()) continue;
      job.lines.push(line);
      emit(job);
    }
    const result = await run.done;
    if (!result.ok) throw new Error(agentFailure(result, run.stderrTail()));

    // The file is the contract; the agent's closing answer is the fallback.
    // Parsing prose for JSON is the brittle version.
    const fromFile = await readIfPresent(planFile);
    const raw = fromFile ?? (result.text || job.lines.join('\n'));
    const parsed = validatePlan(
      {
        ...(extractJson(raw) as Record<string, unknown>),
        jobId: job.id,
        cluster: job.cluster,
        filename: job.filename,
        createdAt: new Date().toISOString(),
        revision: job.revision,
        feedback: revision?.feedback ?? null,
        basis,
      },
      layout,
      facets,
    );

    await writePlan(parsed);
    job.status = 'awaiting_approval';

    // Where a person has decided that this wiki files at once, the plan is
    // carried out now. The job never rests: the panel that follows it sees
    // planning turn into executing. Anything that stops it, such as another
    // filing holding the wiki, leaves the plan waiting for a person instead.
    if ((await readSettings(job.cluster)).filing === 'automatic') {
      await sandbox.dispose();
      sandbox = null;
      try {
        job.automatic = true;
        await startExecution(job, parsed);
        await audit({ event: 'filing-automatic', detail: `${job.cluster}: ${job.filename}` });
        return;
      } catch (err) {
        job.automatic = false;
        job.lines.push(`Not filed at once: ${err instanceof Error ? err.message : String(err)} Waiting for a decision.`);
      }
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    await sandbox?.dispose();
    if (job.status !== 'executing') {
      job.endedAt = new Date().toISOString();
      await persist(job);
      emit(job);
    }
  }
}

/** The execution pass. The lock is held for exactly this. */
async function execute(job: Job, approved: Plan): Promise<void> {
  try {
    if (!job.stagedPath) throw new Error('The staged document for this ingest is gone');
    const layout = await layoutOf(job.cluster);

    // A wiki that came here without history gets its restore point before
    // anything is written, not after.
    await ensureRepo(job.cluster, layout);

    const before = await snapshot(job.cluster);
    const baseline = await beforeIngest(job.cluster, before, layout);

    // Staging → the sources. This is the first write into the wiki, and it
    // happens only now, after a human said yes.
    const rawDir = clusterPath(job.cluster, layout.rawDir);
    await fs.mkdir(rawDir, { recursive: true });

    // Staging names carry a uuid prefix so two uploads of the same filename
    // cannot collide before either is approved. The sources are part of the
    // wiki's own record and get the clean name — unless that name is already
    // taken, in which case the prefix is what keeps this from silently
    // overwriting an earlier source document.
    const staged = path.basename(job.stagedPath);
    const clean = sourceName(staged.replace(/^[0-9a-f-]{36}__/i, ''), layout);
    const taken = await fs.stat(path.join(rawDir, clean)).then(() => true, () => false);
    const rawFile = path.join(rawDir, taken ? `${staged.slice(0, 8)}-${clean}` : clean);
    await move(job.stagedPath, rawFile);
    job.stagedPath = null;
    const rawPath = `${layout.rawDir}/${path.basename(rawFile)}`;

    // Where the sources are kept under the name they were filed by, the file
    // that was uploaded goes beside the text that was made from it.
    if (layout.datedSources && job.originalPath) {
      const ext = path.extname(job.originalPath).toLowerCase();
      const beside = path.join(rawDir, `${path.basename(rawFile, '.md')}${ext}`);
      if (ext && ext !== '.md' && !(await fs.stat(beside).then(() => true, () => false))) {
        await move(job.originalPath, beside);
        job.originalPath = null;
      }
    }

    // Taken again now that the document is in place, so that the check
    // afterwards also notices a change to the document being filed.
    baseline.sources = await sourceFingerprints(job.cluster, layout);

    const run = runClaude({
      mode: 'execute',
      prompt: executePrompt(job, layout, approved, rawPath),
      cwd: clusterPath(job.cluster),
      layout,
      usageFile: path.join(JOBS_DIR, `${job.id}.usage.json`),
      timeoutMs: INGEST_TIMEOUT_MS,
    });

    for await (const line of run.lines) {
      if (!line.trim()) continue;
      job.lines.push(line);
      emit(job);
    }
    const result = await run.done;
    if (!result.ok) throw new Error(agentFailure(result, run.stderrTail()));

    job.diff = await diffAgainst(job.cluster, before);

    // The agent exited cleanly. That says nothing about whether it did the
    // job. Look at the disk before telling the user it is filed.
    job.lint = await lintAfterIngest(job.cluster, baseline);
    job.status = job.lint.ok ? 'done' : 'attention';

    // The restore point, after the write and after the check — so the commit
    // message can say what the check found.
    job.commit = await commitCluster(
      job.cluster,
      `Ingest ${job.filename}\n\n${job.lint.ok ? 'Checks passed.' : 'Checks found problems; see the dashboard.'}`,
      layout,
    );

    // The plan has been carried out; it is no longer a pending decision.
    await deletePlan(job.id);
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    job.endedAt = new Date().toISOString();
    busy.delete(job.cluster);
    await persist(job);
    emit(job);
  }
}

/**
 * The planning prompt.
 *
 * Written in the founder's language on purpose. A plan that reads "create
 * entities/mark-chen.md" asks the reviewer to audit a filesystem diff; a plan
 * that reads "Mark Chen owns the Q4 forecast" asks them whether the document
 * was understood, which is the only question they can actually answer.
 *
 * The agent is never asked for a path. plans.ts derives those from the kind and
 * the name after the plan is validated.
 *
 * The wiki rules (prompts/llm-wiki.md) are given to every run. Here they are
 * named for orientation and naming only, because a planner that starts filing
 * pages is doing the other job. The sandbox and the planner's tool profile are
 * what actually prevent that; this just avoids inviting it.
 */
function planPrompt(
  job: Job,
  layout: Layout,
  facets: Facet[],
  sourceRelPath: string,
  planFile: string,
  revision: { feedback: string; previous: Plan | null } | null,
): string {
  const kinds = layout.types.map((t) => `"${t.type}"`).join(' | ');
  const facetLines = facets.map((f) => `      "${f.key}": [${f.values.length ? `one or more of ${f.values.map((v) => `"${v.value}"`).join(', ')}` : 'values as the rules say'}]${f.max ? `  (at most ${f.max})` : ''},`);
  const lines = [
    // A machine-readable marker on its own line. The real agent can ignore it;
    // the local fake keys its behaviour off it rather than pattern-matching
    // prose, which is how every local ingest silently became a chat answer for
    // six weeks when one sentence of this prompt was reworded.
    `TASK: PLAN`,
    ``,
    `Read ${layout.rulesFile} first — it defines what this wiki covers, what it tracks, and its naming rules.`,
    `Then read ${indexFile(layout)} to see what the wiki already knows.`,
    `The document to assess is at: ${sourceRelPath}`,
    ``,
    `This is a reading pass. Do not create, edit or delete any wiki page.`,
    `Follow the wiki rules in your instructions for orientation and naming only.`,
    `The one file you write is the plan described below.`,
    ``,
    `Report what you found, in plain business language. Never mention folders,`,
    `filenames or paths — describe things by their name and what they are.`,
    ``,
    `The kinds of page this wiki has:`,
    ...layout.types.map((t) => `- "${t.type}": ${t.holds}`),
    ...(layout.types.some((t) => t.type === 'source')
      ? [`Every document gets exactly one page of the kind "source", which summarises it.`]
      : []),
    ``,
    `Write your answer as JSON to this exact path: ${planFile}`,
    ``,
    `{`,
    `  "pages": [`,
    `    { "kind": ${kinds},`,
    `      "name": "Mark Chen",`,
    `      "summary": "one line, as it would read in the index",`,
    `      "quote": "the verbatim sentence from the source that justifies this",`,
    `      "existing": true if the wiki already has this and you would extend it${facetLines.length ? ',' : ' }'}`,
    ...(facetLines.length ? [...facetLines.slice(0, -1), `${facetLines[facetLines.length - 1].replace(/,$/, ' }')}`] : []),
    `  ],`,
    `  "decisions": [`,
    `    { "statement": "what was decided", "by": "who decided it, or null",`,
    `      "quote": "the verbatim sentence" }`,
    `  ],`,
    `  "links": [`,
    `    { "from": "Returns Portal", "to": "Warehouse Team", "why": "who operates it" }`,
    `  ],`,
    `  "skipped": [`,
    `    { "what": "what you are leaving out", "why": "why it does not belong here" }`,
    `  ]`,
    `}`,
    ``,
    `Every page and every decision must carry a quote. Anything you cannot quote`,
    `from the source does not go in the plan.`,
    `Fill "skipped" honestly — it is how the reader catches you dropping something`,
    `that mattered.`,
  ];

  if (revision) {
    lines.push(
      ``,
      `This is a revision. The reader saw your previous plan and asked for this:`,
      revision.feedback,
      ``,
      `Produce a corrected plan in the same format. Their correction wins over`,
      `your earlier judgement.`,
    );
    if (revision.previous) {
      lines.push(``, `Your previous plan was:`, JSON.stringify(stripBasis(revision.previous), null, 1));
    }
  }

  return lines.join('\n');
}

/**
 * The execution prompt. Here the wiki rules apply in full — this is the pass
 * they were written for — and the approved plan is the specification.
 */
function executePrompt(job: Job, layout: Layout, approved: Plan, rawPath: string): string {
  const pages = approved.pages.map((p) => {
    const facets = Object.entries(p.facets)
      .filter(([, values]) => values.length > 0)
      .map(([key, values]) => `${key}: [${values.join(', ')}]`)
      .join(' · ');
    return `- ${p.existing ? 'Update' : 'Create'} "${p.name}" (${p.kind}) at ${pathFor(p, layout)} — ${p.summary}${facets ? ` — ${facets}` : ''}`;
  });
  const links = approved.links.map(
    (l) => `- Link [[${linkFor(l.from, layout)}]] to [[${linkFor(l.to, layout)}]] — ${l.why}`,
  );
  const decisions = approved.decisions.map(
    (d) => `- ${d.statement}${d.by ? ` (decided by ${d.by})` : ''}`,
  );

  return [
    `TASK: EXECUTE`,
    ``,
    `A human has reviewed and approved the plan below. The source document is at ${rawPath}.`,
    `Read ${layout.rulesFile} and ${indexFile(layout)} first, then carry out the plan, following the wiki rules in your instructions.`,
    ``,
    `Pages:`,
    ...(pages.length ? pages : ['- (none)']),
    ``,
    `Connections to make:`,
    ...(links.length ? links : ['- (none)']),
    ``,
    ...(decisions.length ? [`Decisions to record on the relevant pages:`, ...decisions, ``] : []),
    `Write the pages exactly at the paths given above — those names were approved,`,
    `do not rename them. Then:`,
    `1. Update ${indexFile(layout)} with a one-line summary for every page you created or changed.`,
    `2. Append a single entry to ${logFile(layout)} in the format: ## [YYYY-MM-DD] ingest | ${job.filename}`,
    ``,
    `Do not add pages that are not in this plan. If the source clearly requires`,
    `something the plan missed, write the pages that were approved and say what`,
    `you left out at the end of your output.`,
  ].join('\n');
}

/**
 * The name a source is kept under. Where the wiki dates its sources, that is
 * the day it was filed and the name in lower case with hyphens, unless the
 * name starts with a date already.
 */
function sourceName(name: string, layout: Layout): string {
  if (!layout.datedSources) return name;
  const stem = slugFor(path.basename(name, path.extname(name))) || 'source';
  const dated = /^\d{4}-\d{2}-\d{2}-/.test(stem) ? stem : `${new Date().toISOString().slice(0, 10)}-${stem}`;
  return `${dated}.md`;
}

/** rename, or copy and remove: staging and the wiki may be on different mounts. */
async function move(from: string, to: string): Promise<void> {
  await fs.rename(from, to).catch(async (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  });
}

/** The basis is bookkeeping; showing it back to the agent is noise in context. */
function stripBasis(plan: Plan): Omit<Plan, 'basis'> {
  const { basis: _basis, ...rest } = plan;
  return rest;
}

function emit(job: Job): void {
  for (const fn of listeners.get(job.id) ?? []) fn(job);
}

async function persist(job: Job): Promise<void> {
  cache.set(job.id, job);
  await ensureDashboardDirs();
  await fs.writeFile(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
}

/**
 * Job records predate several of the fields above, and older ones were written
 * before the two-phase flow existed. Fill the gaps rather than casting — a
 * missing field should render as absent, not crash the page that reads it.
 */
async function readJobFile(file: string): Promise<Job | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Job>;
    if (!raw || typeof raw.id !== 'string') return null;
    return {
      id: raw.id,
      cluster: String(raw.cluster ?? ''),
      filename: String(raw.filename ?? 'document'),
      // 'running' is the pre-two-phase name for what is now 'executing'.
      status: normalizeStatus(raw.status),
      startedAt: String(raw.startedAt ?? new Date(0).toISOString()),
      endedAt: raw.endedAt ?? null,
      lines: Array.isArray(raw.lines) ? raw.lines.map(String) : [],
      diff: raw.diff ?? null,
      lint: raw.lint ?? null,
      commit: raw.commit ?? null,
      stagedPath: raw.stagedPath ?? null,
      originalPath: raw.originalPath ?? null,
      revision: Number(raw.revision ?? 1) || 1,
      automatic: raw.automatic === true,
      undoCommit: raw.undoCommit ?? null,
      error: raw.error ?? null,
    };
  } catch {
    return null;
  }
}

function normalizeStatus(status: unknown): JobStatus {
  if (status === 'running') return 'executing';
  const all: JobStatus[] = [...ACTIVE, ...FINAL, 'awaiting_approval'];
  return all.includes(status as JobStatus) ? (status as JobStatus) : 'interrupted';
}
