import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DASHBOARD_DIR,
  HttpError,
  JOBS_DIR,
  ORIGINALS_DIR,
  PLANS_DIR,
  STAGING_DIR,
  TRANSCRIPTS_DIR,
  WIKI_ROOT,
  assertClusterName,
  clusterPath,
} from './config';
import { exists, readIfPresent } from './files';
import { BRAIN, CLUSTER, indexFile, layoutOf, type Layout } from './layout';
import { listPages } from './wiki';

const exec = promisify(execFile);

export interface Cluster {
  name: string;
  title: string;
  scope: string;
  pageCount: number;
  updatedAt: string | null;
  /** How the wiki is laid out on disk. See lib/layout.ts. */
  layout: Layout['id'];
}

/** Create the dashboard-owned directories. Safe to call on every boot. */
export async function ensureDashboardDirs(): Promise<void> {
  for (const dir of [WIKI_ROOT, DASHBOARD_DIR, JOBS_DIR, STAGING_DIR, PLANS_DIR, ORIGINALS_DIR, TRANSCRIPTS_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * There is no clusters.json. A wiki *is* a directory containing an index.md,
 * at its top or in wiki/, so listing is a readdir plus a filter. Nothing to
 * drift out of sync, and a wiki stays portable.
 *
 * .dashboard/ has no index.md, which is exactly why it is invisible here.
 */
export async function listClusters(): Promise<Cluster[]> {
  await ensureDashboardDirs();
  const entries = await fs.readdir(WIKI_ROOT, { withFileTypes: true });
  const out: Cluster[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    // A folder someone put there by hand can have any name. One this app cannot
    // address is left out rather than listed and then refused.
    if (!/^[a-z0-9_-]+$/.test(entry.name)) continue;
    const dir = path.join(WIKI_ROOT, entry.name);
    const found = await Promise.all([CLUSTER, BRAIN].map((layout) => exists(path.join(dir, indexFile(layout)))));
    if (!found.some(Boolean)) continue;
    out.push(await describeCluster(entry.name));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function describeCluster(name: string): Promise<Cluster> {
  assertClusterName(name);
  const dir = clusterPath(name);
  const layout = await layoutOf(name);
  const rules = await readIfPresent(path.join(dir, layout.rulesFile));
  let updatedAt: string | null = null;
  try {
    updatedAt = (await fs.stat(path.join(dir, indexFile(layout)))).mtime.toISOString();
  } catch {
    /* the wiki exists but has never been filed into */
  }

  return {
    name,
    title: titleCase(name),
    scope: scopeOf(rules, layout),
    pageCount: (await listPages(name)).total,
    updatedAt,
    layout: layout.id,
  };
}

/**
 * Cluster creation is the dashboard's job; everything inside the cluster is the
 * agent's. We make the directory, write SCHEMA.md from the interview, and git
 * init — because git is the rollback mechanism for a bad ingest, and bad
 * ingests happen from the very first one.
 */
export async function createCluster(input: {
  name: string;
  scope: string;
  entities: string;
  questions: string;
}): Promise<Cluster> {
  const name = assertClusterName(input.name);
  const dir = clusterPath(name);

  if (await exists(dir)) {
    throw new HttpError(409, `A cluster named "${name}" already exists`);
  }
  if (!input.scope.trim()) {
    throw new HttpError(400, 'Scope is required — it is what makes this cluster behave differently from the others');
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SCHEMA.md'), renderSchema(input), 'utf8');

  // index.md and log.md are written here, not left to the first ingest.
  //
  // Two reasons. A cluster *is* a directory containing index.md — that is the
  // readdir filter in listClusters() — so without it a newly created cluster is
  // invisible in the UI, and you cannot upload to something you cannot see.
  // And the wiki rules (prompts/llm-wiki.md) have the agent read both files at
  // the start of every run. Handing it an empty scaffold matches what it expects.
  const today = new Date().toISOString().slice(0, 10);

  await fs.writeFile(
    path.join(dir, 'index.md'),
    `# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: ${today} | Total pages: 0

## Entities

## Concepts

## Comparisons

## Queries
`,
    'utf8',
  );

  await fs.writeFile(
    path.join(dir, 'log.md'),
    `# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: \`## [YYYY-MM-DD] action | subject\`
> Actions: ingest, update, query, lint, create, archive, delete
> When this file exceeds 500 entries, rotate: rename to log-YYYY.md, start fresh.

## [${today}] create | Cluster initialized
- Domain: ${input.scope.trim().split('\n')[0]}
- Structure created with SCHEMA.md, index.md, log.md
`,
    'utf8',
  );

  // Per-cluster git, never at WIKI_ROOT: a root-level repo collapses every
  // cluster into one shared history. Failure here is not fatal — the cluster
  // works, it just has no rollback until someone fixes git.
  try {
    await exec('git', ['init'], { cwd: dir });
    await exec('git', ['add', '.'], { cwd: dir });
    await exec('git', ['-c', 'user.email=brain-app@localhost', '-c', 'user.name=Second Brain', 'commit', '-m', 'Create cluster'], { cwd: dir });
  } catch (err) {
    console.error(`[clusters] git init failed for ${name} — no ingest rollback available`, err);
  }

  return describeCluster(name);
}

/** SCHEMA.md is the highest-leverage file in the system: it is what makes
 *  Operations behave differently from Finance. It is written here, from what a
 *  person said, and the agent is refused the right to change it. */
function renderSchema(input: { name: string; scope: string; entities: string; questions: string }): string {
  return `# ${titleCase(input.name)} — Schema

## Scope
${input.scope.trim()}

Anything outside this scope does not belong in this cluster. If a source document
covers several areas, file only the parts that fall inside the scope above.

## Entities to track
${input.entities.trim() || '_None specified at creation._'}

## Questions this cluster should answer
${input.questions.trim() || '_None specified at creation._'}

## Naming and linking rules
- One page per entity or concept. Prefer updating an existing page over creating a near-duplicate.
- Every page carries at least two \`[[wikilinks]]\` to other pages in this cluster.
- Keep \`index.md\` current: every page listed with a one-line summary.
- Append every ingest to \`log.md\` with the source filename and what changed.

## Sources
Documents arrive in \`raw/\` already converted to Markdown, each with a short block at
the top that records where it came from, when, and a checksum. They are never edited.
`;
}

/**
 * What the wiki is about, in a line, from its rules: the first line under
 * "Scope" where there is one, and otherwise the first sentence that is not a
 * heading.
 */
function scopeOf(rules: string | null, layout: Layout): string {
  if (!rules) return `No ${layout.rulesFile} yet`;
  const scope = rules.match(/##\s*Scope\s*\n+([^\n]+)/i)?.[1]?.trim();
  if (scope) return scope;

  const first = rules
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|\||---|```|>|[-*]\s)/.test(block));
  if (!first) return 'No scope recorded';
  const line = first.replace(/\s+/g, ' ').replace(/[*_`]/g, '');
  const sentence = line.match(/^.{20,240}?[.!?](?=\s|$)/)?.[0] ?? line;
  return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence;
}

export function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Asked everywhere, and kept in a module of their own so that this one and
// the one that reads the pages can use them without importing each other.
export { exists, readIfPresent };
