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

const exec = promisify(execFile);

export interface Cluster {
  name: string;
  title: string;
  scope: string;
  pageCount: number;
  updatedAt: string | null;
}

/** Create the dashboard-owned directories. Safe to call on every boot. */
export async function ensureDashboardDirs(): Promise<void> {
  for (const dir of [WIKI_ROOT, DASHBOARD_DIR, JOBS_DIR, STAGING_DIR, PLANS_DIR, ORIGINALS_DIR, TRANSCRIPTS_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * There is no clusters.json. A cluster *is* a directory containing an index.md,
 * so listing is a readdir plus a filter. Nothing to drift out of sync, and a
 * cluster stays portable.
 *
 * .dashboard/ has no index.md, which is exactly why it is invisible here.
 */
export async function listClusters(): Promise<Cluster[]> {
  await ensureDashboardDirs();
  const entries = await fs.readdir(WIKI_ROOT, { withFileTypes: true });
  const out: Cluster[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(WIKI_ROOT, entry.name);
    if (!(await exists(path.join(dir, 'index.md')))) continue;
    out.push(await describeCluster(entry.name));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function describeCluster(name: string): Promise<Cluster> {
  assertClusterName(name);
  const dir = clusterPath(name);
  const schema = await readIfPresent(path.join(dir, 'SCHEMA.md'));
  let updatedAt: string | null = null;
  try {
    updatedAt = (await fs.stat(path.join(dir, 'index.md'))).mtime.toISOString();
  } catch {
    /* cluster exists but has never been ingested into */
  }

  return {
    name,
    title: titleCase(name),
    scope: firstScopeLine(schema),
    pageCount: await countPages(name),
    updatedAt,
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
  // And the llm-wiki skill's own "Initializing a New Wiki" procedure writes
  // both files at init; its orientation step then reads them at the start of
  // every session. Handing the agent an empty scaffold matches what it expects.
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
    await exec('git', ['-c', 'user.email=dashboard@localhost', '-c', 'user.name=Dashboard', 'commit', '-m', 'Create cluster'], { cwd: dir });
  } catch (err) {
    console.error(`[clusters] git init failed for ${name} — no ingest rollback available`, err);
  }

  return describeCluster(name);
}

/** SCHEMA.md is the highest-leverage file in the system: it is what makes
 *  Operations behave differently from Finance. It also tells the agent which
 *  parsing tools it has, so it doesn't have to guess. */
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

## Parsing tools available on this machine
- \`markitdown <file>\` — default converter for PDF, DOCX, XLSX, PPTX, HTML, CSV, EPub
- \`tesseract\` — OCR fallback for scanned PDFs with no text layer
- \`pandoc\` — format conversion
Reach for OCR only when a document has no extractable text layer.
`;
}

async function countPages(name: string): Promise<number> {
  let total = 0;
  for (const sub of ['entities', 'concepts', 'comparisons', 'queries']) {
    try {
      const files = await fs.readdir(clusterPath(name, sub));
      total += files.filter((f) => f.endsWith('.md')).length;
    } catch {
      /* the skill may not scaffold every directory — absence is not an error */
    }
  }
  return total;
}

function firstScopeLine(schema: string | null): string {
  if (!schema) return 'No SCHEMA.md yet';
  const match = schema.match(/##\s*Scope\s*\n+([^\n]+)/i);
  return match?.[1]?.trim() ?? 'No scope recorded';
}

export function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readIfPresent(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
