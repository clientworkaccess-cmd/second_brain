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
  SETTINGS_DIR, CONVERSATIONS_DIR,
  STAGING_DIR,
  TRANSCRIPTS_DIR,
  WIKI_ROOT,
  assertClusterName,
  clusterPath,
} from './config';
import { AREAS_BY_DEFAULT, labelOf } from './facets';
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
  for (const dir of [WIKI_ROOT, DASHBOARD_DIR, JOBS_DIR, STAGING_DIR, PLANS_DIR, ORIGINALS_DIR, TRANSCRIPTS_DIR, SETTINGS_DIR, CONVERSATIONS_DIR]) {
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

/**
 * A brain, made from the interview: the layout a wiki kept by hand has (see
 * lib/layout.ts), with a CLAUDE.md that sets the rules, a registry of the
 * businesses, and the areas the schema this layout follows names.
 *
 * `businesses` is one per line: "harbour-bakery: Harbour Bakery", or just the
 * name, which is then made into a slug.
 */
export async function createBrain(input: { name: string; scope: string; businesses: string; questions: string }): Promise<Cluster> {
  const name = assertClusterName(input.name);
  const dir = clusterPath(name);

  if (await exists(dir)) throw new HttpError(409, `A wiki named "${name}" already exists`);
  if (!input.scope.trim()) throw new HttpError(400, 'Say what this wiki covers');
  const businesses = parseBusinesses(input.businesses);
  if (businesses.length === 0) throw new HttpError(400, 'Name at least one business, one per line');

  const wiki = path.join(dir, 'wiki');
  for (const type of BRAIN.types) await fs.mkdir(path.join(wiki, type.dir), { recursive: true });
  await fs.mkdir(path.join(dir, 'raw', 'inbox'), { recursive: true });
  await fs.mkdir(path.join(dir, 'raw', 'assets'), { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const block = (fields: Record<string, string>): string =>
    `---\n${Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n---\n\n`;
  const meta = (title: string, type: string): string =>
    block({ title, type, business: '[group]', area: '[strategy]', created: today, updated: today, confidence: 'high' });

  await fs.writeFile(path.join(dir, 'CLAUDE.md'), renderBrainSchema(name, input, businesses), 'utf8');
  await fs.writeFile(
    path.join(wiki, 'businesses.md'),
    `${meta('Business Registry', 'concept')}# Business Registry

Valid values for the \`business:\` facet. The agent must not invent new ones; a person adds a row here.

| slug | name | main page | notes |
|---|---|---|---|
| \`group\` | All businesses | [[overview]] | reserved: what applies to the whole group |
${businesses.map((b) => `| \`${b.slug}\` | ${b.name} | [[${b.slug}]] | |`).join('\n')}
`,
    'utf8',
  );
  await fs.writeFile(
    path.join(wiki, 'overview.md'),
    `${meta('Overview', 'synthesis')}# Overview

${input.scope.trim()}

${businesses.map((b) => `- [[${b.slug}]]: ${b.name}`).join('\n')}

The values for \`business:\` are in [[businesses]].
`,
    'utf8',
  );
  for (const b of businesses) {
    await fs.writeFile(
      path.join(wiki, 'entities', `${b.slug}.md`),
      `${block({ title: b.name, type: 'entity', business: `[${b.slug}]`, area: '[strategy]', created: today, updated: today, confidence: 'medium' })}# ${b.name}

One of the businesses of the group. See [[overview]] and [[businesses]].
`,
      'utf8',
    );
  }
  await fs.writeFile(
    path.join(wiki, 'index.md'),
    `# Index

Catalogue of every wiki page: \`link: summary · business · area\`.

## Overview
- [[overview]]: big picture, priorities, open questions · group · strategy
- [[businesses]]: registry of valid business slugs · group · strategy

## Sources

## Entities
${businesses.map((b) => `- [[${b.slug}]]: ${b.name} · ${b.slug} · strategy`).join('\n')}

## Concepts

## Synthesis
`,
    'utf8',
  );
  await fs.writeFile(
    path.join(wiki, 'log.md'),
    `# Log

## [${today}] schema | Wiki initialised
- Structure set up per CLAUDE.md
- Businesses: ${businesses.map((b) => b.slug).join(', ')}
`,
    'utf8',
  );

  try {
    await exec('git', ['init'], { cwd: dir });
    await exec('git', ['add', '-A', '--', 'wiki', 'raw', 'CLAUDE.md'], { cwd: dir });
    await exec('git', ['-c', 'user.email=brain-app@localhost', '-c', 'user.name=Second Brain', 'commit', '-m', 'Create wiki'], { cwd: dir });
  } catch (err) {
    console.error(`[clusters] git init failed for ${name} — no ingest rollback available`, err);
  }

  return describeCluster(name);
}

/** "harbour-bakery: Harbour Bakery" or "Harbour Bakery", one per line. */
export function parseBusinesses(text: string): { slug: string; name: string }[] {
  const out: { slug: string; name: string }[] = [];
  const seen = new Set<string>(['group']);
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^[\s*-]+/, '').trim();
    if (!trimmed) continue;
    const [left, ...rest] = trimmed.split(/[:|]/);
    const name = (rest.join(':').trim() || left.trim()).replace(/[*_`]/g, '');
    const slug = slugOf(rest.length ? left : name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name });
  }
  return out;
}

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function renderBrainSchema(name: string, input: { scope: string; questions: string }, businesses: { slug: string; name: string }[]): string {
  return `# ${titleCase(name)}: Wiki Schema

This folder is a knowledge base about a group of businesses, kept by an agent. People add
sources and ask questions; the agent writes and maintains every page in \`wiki/\`. Read this
file before any operation.

## Scope

${input.scope.trim()}

## Layers

| Path | Owner | Rule |
|---|---|---|
| \`raw/inbox/\` | human | Drop zone for sources. Each is moved to \`raw/\` once ingested. |
| \`raw/\` | human | **Immutable.** Never edit or delete a source after ingest. |
| \`raw/assets/\` | human | Images and attachments referenced by sources. |
| \`wiki/\` | agent | All compiled knowledge. The agent creates, updates and cross-links it. |
| \`CLAUDE.md\` | shared | This schema. Changes are agreed with a person. |

## Page types (folder = what kind of page it is)

- \`wiki/sources/\`: one summary per raw source (\`YYYY-MM-DD-short-slug.md\`).
- \`wiki/entities/\`: people, companies, clients, vendors, products, tools, places.
- \`wiki/concepts/\`: ideas, processes, playbooks, policies, metrics, recurring themes.
- \`wiki/synthesis/\`: comparisons, analyses and answers to questions worth keeping.
- \`wiki/index.md\`: catalogue of every page, grouped by type, one line each.
- \`wiki/log.md\`: append-only activity log.
- \`wiki/overview.md\`: the current big picture across all businesses.
- \`wiki/businesses.md\`: registry of valid \`business:\` values.

Folders never encode business or department.

## Facets: business and area

Every page carries two facets in its frontmatter:

- \`business:\` which company or companies the page concerns. A list, with values only
  from \`wiki/businesses.md\` (today: ${businesses.map((b) => `\`${b.slug}\``).join(', ')}). Use
  \`group\` when the page applies to the whole group. If a source names a business that
  is not registered, leave it out and say so; do not invent a slug.
- \`area:\` which kind of work it is. A list, with values only from this fixed set:

| area | covers |
|---|---|
${AREAS_BY_DEFAULT.map((area) => `| \`${area}\` | ${AREA_COVERS[area] ?? labelOf(area)} |`).join('\n')}

Tag with every area that really applies, but keep it to three at most.

## Frontmatter (required on every wiki page)

\`\`\`yaml
---
title: Human Readable Title
type: source | entity | concept | synthesis
business: [${businesses[0].slug}]
area: [marketing, sales]
tags: []
sources: [2026-01-22-slug]
created: 2026-01-22
updated: 2026-01-22
confidence: high | medium | low
---
\`\`\`

Source pages also add \`date:\` and \`raw: raw/<filename>\`.

## Conventions

- Slugs are lowercase and hyphenated. File name = slug. Link with \`[[slug]]\`.
- Every claim traces to a source page. Cite inline, for example \`([[2026-01-22-board-pack]])\`.
- When sources conflict, keep both claims and flag them with \`> [!conflict]\`.
- Prefer updating an existing page to creating a near-duplicate.
- Dates are absolute (YYYY-MM-DD).
- Don't store secrets (passwords, API keys, bank details) even if a source contains them.
${input.questions.trim() ? `
## Questions this wiki should answer

${input.questions
  .trim()
  .split('\n')
  .map((q) => q.trim())
  .filter(Boolean)
  .map((q) => `- ${q}`)
  .join('\n')}
` : ''}
## Log format (\`wiki/log.md\`, append-only)

\`\`\`
## [YYYY-MM-DD] ingest | Source Title
- business: [..] · area: [..]
- pages: created [[a]], [[b]]; updated [[c]]
\`\`\`
`;
}

const AREA_COVERS: Record<string, string> = {
  strategy: 'direction, planning, goals, M&A, board',
  marketing: 'brand, content, ads, SEO, social, campaigns',
  sales: 'leads, pipeline, CRM, proposals, clients',
  operations: 'delivery, processes, fulfilment, suppliers, scheduling',
  finance: 'accounting, cash, pricing, tax, payroll, reporting',
  people: 'hiring, team, roles, HR, training',
  product: 'offerings, services, features, roadmap',
  technology: 'systems, automations, integrations, AI, data',
  legal: 'contracts, compliance, risk, IP',
  customer: 'support, reviews, retention, service quality',
};

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
