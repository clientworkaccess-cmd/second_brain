import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { audit } from './audit';
import { HttpError, INGEST_DIR, STAGING_DIR, assertClusterName, clusterPath } from './config';
import { ensureDashboardDirs, exists } from './clusters';
import { readIfPresent } from './files';
import { approvePlan, getJob, isActive, rejectPlan, startPlanning, subscribe, type JobStatus } from './jobs';

/**
 * Documents sent in by n8n: the day's email as a digest, a meeting's
 * transcript. Each is filed exactly as an uploaded document is (lib/jobs.ts:
 * plan, the wiki's rules, the check afterwards, a commit, undo), one at a time
 * per brain, in the order they arrived, and without waiting for anyone: the
 * plan is carried out as soon as it is made, whatever the brain is set to for
 * uploads. If the brain is being written to at that moment, the plan waits and
 * is carried out when it is free; if the brain changed under it, the document
 * is planned again.
 *
 * Why a queue: a filing plans against the brain as it is, and one that lands
 * first makes the others' plans stale. So the next document is only planned
 * once the one before it has been filed, or decided on by a person where the
 * brain waits for approval. The sender gets `queued` at once and never sees
 * "busy".
 *
 * Why a register: n8n may send the same message twice (a retry, a table
 * wiped). Every document carries the sender's id for it; the second time it is
 * acknowledged as a duplicate and not filed again. The register is a file per
 * id, created exclusively, so two copies arriving together cannot both get in.
 *
 * On disk, under .dashboard/ingest/:
 *   items/<id>.json   what came in and where it is: queued, filing, filed, failed
 *   items/<id>.md     the document itself
 *   seen/<hash>       one per brain and sender id, holding the item's id
 */

export type IngestKind = 'email' | 'transcript' | 'document';
export type IngestState = 'queued' | 'filing' | 'filed' | 'failed';

export interface IngestRequest {
  cluster: string;
  title: string;
  text: string;
  sourceId: string;
  kind: IngestKind;
  /** YYYY-MM-DD the document is about, if the sender knows it. */
  date: string | null;
}

export interface IngestItem {
  id: string;
  cluster: string;
  sourceId: string;
  title: string;
  kind: IngestKind;
  date: string | null;
  receivedAt: string;
  state: IngestState;
  jobId: string | null;
  /** The job's last status, once it has one. */
  jobStatus: JobStatus | null;
  /** How many times filing was started; an interrupted one is tried again, once. */
  attempts: number;
  error: string | null;
}

const TITLE_MAX = 200;
const TEXT_MAX = 1_000_000;
const SOURCE_ID = /^[\x21-\x7e][\x20-\x7e]{0,299}$/;
const KINDS: readonly IngestKind[] = ['email', 'transcript', 'document'];
const MAX_ATTEMPTS = 2;
const TICK_MS = 60_000;

const ITEMS_DIR = path.join(INGEST_DIR, 'items');
const SEEN_DIR = path.join(INGEST_DIR, 'seen');

// ------------------------------------------------------------------ access

/**
 * Whether a request may send documents. Only a caller on the server itself.
 *
 * The app listens on loopback, so everything reaches it from 127.0.0.1, and
 * that alone says nothing: nginx is on loopback too. What tells them apart is
 * what nginx adds. It sets X-Real-IP, which Next does not; and it puts the
 * visitor's address in X-Forwarded-For, where Next, for a caller that reached
 * it directly, puts the socket's own (loopback) address. So a request is let
 * in only with no X-Real-IP or Forwarded header and nothing but loopback
 * addresses in X-Forwarded-For. nginx refuses the path as well. A token is
 * checked too when INGEST_TOKEN is set. Null when allowed; otherwise why not.
 */
export function ingestRefusal(headers: { get(name: string): string | null }, token: string | undefined = process.env.INGEST_TOKEN): string | null {
  const outside = 'Documents can only be sent from the server itself.';
  if (headers.get('x-real-ip') !== null || headers.get('forwarded') !== null) return outside;
  const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!hops.every(isLoopback)) return outside;
  const wanted = (token ?? '').trim();
  if (wanted) {
    const given = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const a = Buffer.from(given);
    const b = Buffer.from(wanted);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'Not authorised.';
  }
  return null;
}

function isLoopback(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  return a === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// ------------------------------------------------------------------ input

/** A request body as a document to file, checked field by field. Throws a 400 that says what is wrong. */
export function parseIngest(body: unknown): IngestRequest {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Send a JSON object.');
  const o = body as Record<string, unknown>;
  const cluster = assertClusterName(String(o.brain ?? o.cluster ?? ''));
  const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new HttpError(400, 'Give it a title.');
  if (title.length > TITLE_MAX) throw new HttpError(400, `The title is longer than ${TITLE_MAX} characters.`);
  const text = typeof o.text === 'string' ? o.text.replace(/\r\n/g, '\n').trim() : '';
  if (!text) throw new HttpError(400, 'There is no text.');
  if (text.length > TEXT_MAX) throw new HttpError(400, 'The text is too long. Split it into several documents.');
  const sourceId = typeof o.sourceId === 'string' ? o.sourceId.trim() : '';
  if (!SOURCE_ID.test(sourceId)) throw new HttpError(400, 'Give a sourceId: the id the sender has for this document, on one line.');
  const kind = KINDS.includes(o.kind as IngestKind) ? (o.kind as IngestKind) : 'document';
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date.trim()) ? o.date.trim() : null;
  return { cluster, title, text, sourceId, kind, date };
}

/** The document as it is staged for filing: the block an upload gets at the top, then the title and text. */
export function documentFor(req: IngestRequest, now: Date = new Date()): string {
  const sha256 = createHash('sha256').update(req.text).digest('hex');
  return [
    '---',
    `source_url: ingest://${req.kind}/${encodeURIComponent(req.sourceId)}`,
    `ingested: ${now.toISOString().slice(0, 10)}`,
    ...(req.date ? [`date: ${req.date}`] : []),
    `kind: ${req.kind}`,
    `sha256: ${sha256}`,
    '---',
    '',
    `# ${req.title}`,
    '',
    req.text,
    '',
  ].join('\n');
}

/** The file name a filing shows for it. */
export function filenameFor(req: Pick<IngestRequest, 'title' | 'kind' | 'date'>): string {
  const base = req.title.replace(/[^\w.\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || req.kind;
  return `${req.date ? `${req.date} ` : ''}${base}.md`;
}

const seenKey = (cluster: string, sourceId: string): string => createHash('sha256').update(`${cluster}\n${sourceId}`).digest('hex');

// ------------------------------------------------------------------ store

async function saveItem(item: IngestItem): Promise<void> {
  await fs.mkdir(ITEMS_DIR, { recursive: true });
  const file = path.join(ITEMS_DIR, `${item.id}.json`);
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(item, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

export async function readItem(id: string): Promise<IngestItem | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const raw = await readIfPresent(path.join(ITEMS_DIR, `${id}.json`));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as IngestItem;
  } catch {
    return null;
  }
}

export async function listItems(cluster?: string): Promise<IngestItem[]> {
  const names = await fs.readdir(ITEMS_DIR).catch(() => [] as string[]);
  const items: IngestItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const item = await readItem(name.slice(0, -5));
    if (item && (!cluster || item.cluster === cluster)) items.push(item);
  }
  return items.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/**
 * A document received: registered under its sender's id, kept, and queued.
 * A second one with the same id for the same brain is a duplicate and changes
 * nothing.
 */
export async function enqueue(req: IngestRequest, now: Date = new Date()): Promise<{ status: 'queued' | 'duplicate'; id: string; position?: number }> {
  if (!(await exists(clusterPath(req.cluster)))) throw new HttpError(404, `No brain named "${req.cluster}"`);
  await ensureDashboardDirs();
  await fs.mkdir(SEEN_DIR, { recursive: true });
  await fs.mkdir(ITEMS_DIR, { recursive: true });

  const id = randomUUID();
  const seen = path.join(SEEN_DIR, seenKey(req.cluster, req.sourceId));
  try {
    await fs.writeFile(seen, id, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return { status: 'duplicate', id: (await fs.readFile(seen, 'utf8').catch(() => '')).trim() };
  }

  await fs.writeFile(path.join(ITEMS_DIR, `${id}.md`), documentFor(req, now), { encoding: 'utf8', mode: 0o600 });
  const item: IngestItem = {
    id,
    cluster: req.cluster,
    sourceId: req.sourceId,
    title: req.title,
    kind: req.kind,
    date: req.date,
    receivedAt: now.toISOString(),
    state: 'queued',
    jobId: null,
    jobStatus: null,
    attempts: 0,
    error: null,
  };
  await saveItem(item);
  await audit({ event: 'ingest-received', detail: `${req.cluster}: ${req.kind} "${req.title.slice(0, 80)}"` });
  const position = (await listItems(req.cluster)).filter((i) => i.state === 'queued' || i.state === 'filing').length;
  kick(req.cluster);
  return { status: 'queued', id, position };
}

// ----------------------------------------------------------------- worker

const globalForIngest = globalThis as typeof globalThis & {
  __brainIngest?: { running: Set<string>; again: Set<string>; watching: Map<string, () => void>; timer: NodeJS.Timeout | null };
};
const worker = (globalForIngest.__brainIngest ??= { running: new Set(), again: new Set(), watching: new Map(), timer: null });

/** Make sure documents keep moving: a check every minute, for after a restart or a missed event. */
export function ensureIngestWorker(): void {
  if (worker.timer) return;
  worker.timer = setInterval(() => {
    void listItems()
      .then((items) => new Set(items.filter((i) => i.state === 'queued' || i.state === 'filing').map((i) => i.cluster)))
      .then((clusters) => clusters.forEach((c) => kick(c)))
      .catch((err) => console.error('[ingest] tick failed', err));
  }, TICK_MS);
  worker.timer.unref?.();
}

/** Move a brain's queue on: settle the document being filed, and start the next when it is done. */
export function kick(cluster: string): void {
  if (worker.running.has(cluster)) {
    worker.again.add(cluster);
    return;
  }
  worker.running.add(cluster);
  void advance(cluster)
    .catch((err) => console.error('[ingest] could not move the queue on', err))
    .finally(() => {
      worker.running.delete(cluster);
      if (worker.again.delete(cluster)) kick(cluster);
    });
}

/** Resolves when nothing is moving any queue: for the checks. */
export async function ingestSettled(): Promise<void> {
  while (worker.running.size > 0) await new Promise((r) => setTimeout(r, 25));
}

const SETTLED_FILED: JobStatus[] = ['done', 'attention'];

async function advance(cluster: string): Promise<void> {
  const items = await listItems(cluster);

  // The one being filed, if any: is it finished?
  for (const item of items.filter((i) => i.state === 'filing')) {
    const job = item.jobId ? await getJob(item.jobId) : null;
    if (!job) {
      item.state = 'failed';
      item.error = 'Its filing is gone.';
      await saveItem(item);
      continue;
    }
    item.jobStatus = job.status;
    if (job.status === 'awaiting_approval') {
      // Planned, but not carried out at once: the brain was being written to, or the job predates filing at once.
      const outcome = await carryOut(job.id);
      if (outcome === 'replan') {
        item.state = 'queued';
        item.jobId = null;
        item.jobStatus = null;
        await saveItem(item);
        continue;
      }
      item.jobStatus = (await getJob(job.id))?.status ?? job.status;
      await saveItem(item);
      watch(item.jobId as string, cluster);
      return;
    }
    if (isActive(job.status)) {
      await saveItem(item);
      watch(item.jobId as string, cluster);
      return; // Still going: the rest wait behind it.
    }
    unwatch(item.jobId as string);
    if (SETTLED_FILED.includes(job.status)) {
      item.state = 'filed';
      item.error = null;
    } else if (job.status === 'interrupted' && item.attempts < MAX_ATTEMPTS) {
      // The server restarted while it was being filed: once more, from the start.
      item.state = 'queued';
      item.jobId = null;
    } else {
      item.state = 'failed';
      item.error = job.error ?? `The filing ended ${job.status}.`;
    }
    await saveItem(item);
  }

  const next = (await listItems(cluster)).find((i) => i.state === 'queued');
  if (!next) return;

  const text = await readIfPresent(path.join(ITEMS_DIR, `${next.id}.md`));
  if (text === null) {
    next.state = 'failed';
    next.error = 'The document is gone.';
    await saveItem(next);
    kick(cluster);
    return;
  }
  const filename = filenameFor(next);
  const stagedPath = path.join(STAGING_DIR, `${randomUUID()}__${filename.replace(/ /g, '_')}`);
  await fs.mkdir(STAGING_DIR, { recursive: true });
  await fs.writeFile(stagedPath, text, 'utf8');
  try {
    const job = await startPlanning({ cluster, filename, stagedPath, originalPath: null, fileAtOnce: true });
    next.state = 'filing';
    next.jobId = job.id;
    next.jobStatus = job.status;
    next.attempts += 1;
    await saveItem(next);
    await audit({ event: 'filing-planned', detail: `${cluster}: ${filename} (sent in)` });
    watch(job.id, cluster);
  } catch (err) {
    next.state = 'failed';
    next.error = err instanceof Error ? err.message : String(err);
    await saveItem(next);
    await fs.rm(stagedPath, { force: true });
    kick(cluster);
  }
}

/**
 * A plan that is waiting, carried out now. 'waiting' when the brain is still
 * being written to (the minute's check tries again), 'replan' when the brain
 * changed since the plan was made (it is put aside and the document planned
 * again), 'started' when it is being written.
 */
async function carryOut(jobId: string): Promise<'started' | 'waiting' | 'replan'> {
  try {
    await approvePlan(jobId);
    return 'started';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already being written to/i.test(message)) return 'waiting';
    if (/changed since this plan was made|missing or unreadable|staged document/i.test(message)) {
      await rejectPlan(jobId).catch(() => {});
      return 'replan';
    }
    console.error('[ingest] could not carry out the plan', err);
    return 'waiting';
  }
}

function watch(jobId: string, cluster: string): void {
  if (worker.watching.has(jobId)) return;
  worker.watching.set(jobId, subscribe(jobId, () => kick(cluster)));
}

function unwatch(jobId: string): void {
  worker.watching.get(jobId)?.();
  worker.watching.delete(jobId);
}

/** How many documents are where, per brain: for the GET the sender can poll. */
export async function queueSummary(cluster?: string): Promise<Record<IngestState, number>> {
  const counts: Record<IngestState, number> = { queued: 0, filing: 0, filed: 0, failed: 0 };
  for (const item of await listItems(cluster)) counts[item.state]++;
  return counts;
}
