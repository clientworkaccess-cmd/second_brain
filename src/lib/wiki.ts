import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, clusterPath } from './config';
import { readIfPresent } from './clusters';
import { splitPage as splitBlock } from './frontmatter';
import { WIKILINK, extractWikilinks, linkifyWikilinks } from './wikilinks';

/**
 * Read-side of the wiki. The dashboard never writes a page — that is the
 * agent's job. Everything here is read-only navigation over what it produced.
 */

export const PAGE_DIRS = ['entities', 'concepts', 'comparisons', 'queries'] as const;
export type PageDir = (typeof PAGE_DIRS)[number];

export interface PageRef {
  /** e.g. "entities/warehouse-team" — the routing id for a page */
  slug: string;
  dir: PageDir;
  title: string;
}

export interface Page extends PageRef {
  body: string;
  updatedAt: string;
  links: string[];
  /** The block at the top of the page, in the order it was written. Empty when there is none. */
  properties: [name: string, value: string][];
}

export interface Backlink {
  slug: string;
  title: string;
  /** The line the link sits in, so the reader sees why the page is mentioned. */
  context: string;
}

/**
 * A page split into the block at its top and the text below it.
 *
 * The agent writes that block, so it can be malformed. A page whose block does
 * not parse is shown whole, block included, rather than failing to open.
 */
export function splitPage(raw: string): { content: string; properties: [string, string][] } {
  const { content, data } = splitBlock(raw);
  return { content, properties: Object.entries(data).map(([name, value]) => [name, show(value)]) };
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '';
  // YAML reads 2026-09-28 as a date, and a date prints with a time and a zone.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(show).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Every page in a cluster, grouped for the sidebar. */
export async function listPages(cluster: string): Promise<Record<PageDir, PageRef[]>> {
  const out = {} as Record<PageDir, PageRef[]>;
  for (const dir of PAGE_DIRS) {
    out[dir] = [];
    let files: string[];
    try {
      files = await fs.readdir(clusterPath(cluster, dir));
    } catch {
      continue; // directory may not exist until the agent creates it
    }
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const slug = `${dir}/${file.replace(/\.md$/, '')}`;
      out[dir].push({ slug, dir, title: await pageTitle(cluster, slug, file) });
    }
    out[dir].sort((a, b) => a.title.localeCompare(b.title));
  }
  return out;
}

export async function readPage(cluster: string, slug: string): Promise<Page> {
  const [dir, ...rest] = slug.split('/');
  if (!PAGE_DIRS.includes(dir as PageDir) || rest.length !== 1) {
    throw new HttpError(400, 'Malformed page slug');
  }
  const file = clusterPath(cluster, dir, `${rest[0]}.md`);
  const raw = await readIfPresent(file);
  if (raw === null) throw new HttpError(404, `No page at ${slug}`);

  const { content, properties } = splitPage(raw);
  const stat = await fs.stat(file);

  return {
    slug,
    dir: dir as PageDir,
    title: headingOf(content) ?? deSlug(rest[0]),
    body: content.trim(),
    updatedAt: stat.mtime.toISOString(),
    links: extractWikilinks(content),
    properties,
  };
}

/** Every page that links to this one, with the line the link is in. */
export async function backlinksOf(cluster: string, slug: string): Promise<Backlink[]> {
  const titles = await titleIndex(cluster);
  const grouped = await listPages(cluster);
  const out: Backlink[] = [];

  for (const dir of PAGE_DIRS) {
    for (const ref of grouped[dir]) {
      if (ref.slug === slug) continue;
      const raw = await readIfPresent(clusterPath(cluster, `${ref.slug}.md`));
      if (raw === null) continue;
      const { content } = splitPage(raw);

      const line = content.split('\n').find((candidate) =>
        extractWikilinks(candidate).some((target) => titles.get(target.toLowerCase()) === slug),
      );
      if (line === undefined) continue;

      out.push({
        slug: ref.slug,
        title: ref.title,
        context: line
          .replace(WIKILINK, (_all, target: string, label?: string) => (label ?? target).trim())
          .replace(/^[\s>#*-]+/, '')
          .trim()
          .slice(0, 240),
      });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** index.md is the agent's own catalog — the entry point for both a human
 *  browsing and the agent answering. */
export async function readIndex(cluster: string): Promise<string | null> {
  return readIfPresent(clusterPath(cluster, 'index.md'));
}

export interface LogEntry {
  /** YYYY-MM-DD, as written. */
  when: string;
  /** ingest, update, query, lint, create, archive or delete. */
  action: string;
  subject: string;
  /** The lines under the entry: what was created or changed. */
  details: string[];
}

/**
 * The entries of log.md, newest first.
 *
 * An entry is a `## [YYYY-MM-DD] action | subject` line and the lines under
 * it. Everything above the first entry is the file's own explanation of its
 * format and is left out.
 */
export async function readLog(cluster: string, limit = 20): Promise<LogEntry[]> {
  const raw = await readIfPresent(clusterPath(cluster, 'log.md'));
  if (!raw) return [];

  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    const head = line.match(/^#{1,6}\s*\[(\d{4}-\d{2}-\d{2})\]\s*([A-Za-z-]+)\s*\|\s*(.+?)\s*$/);
    if (head) {
      entries.push({ when: head[1], action: head[2].toLowerCase(), subject: head[3], details: [] });
      continue;
    }
    const detail = line.replace(/^[\s>*-]+/, '').trim();
    if (detail && entries.length > 0 && !line.startsWith('#')) entries[entries.length - 1].details.push(detail);
  }
  return entries.reverse().slice(0, limit);
}

export interface IngestDiff {
  newPages: number;
  updatedPages: number;
  newConnections: number;
}

/**
 * The payoff screen's numbers. We read them from what is actually on disk
 * rather than trusting the agent's own summary — the verification gate requires
 * the reported diff and the filesystem to agree.
 */
export interface Snapshot {
  /** slug → a cheap content fingerprint, so "updated" means the bytes changed */
  pages: Map<string, string>;
  links: number;
}

export async function diffAgainst(cluster: string, before: Snapshot): Promise<IngestDiff> {
  const after = await snapshot(cluster);
  let newPages = 0;
  let updatedPages = 0;

  for (const [slug, fingerprint] of after.pages) {
    const previous = before.pages.get(slug);
    if (previous === undefined) newPages++;
    else if (previous !== fingerprint) updatedPages++;
  }

  return { newPages, updatedPages, newConnections: Math.max(0, after.links - before.links) };
}

export async function snapshot(cluster: string): Promise<Snapshot> {
  const pages = new Map<string, string>();
  let links = 0;
  const grouped = await listPages(cluster);
  for (const dir of PAGE_DIRS) {
    for (const ref of grouped[dir]) {
      const raw = await readIfPresent(clusterPath(cluster, `${ref.slug}.md`));
      if (raw === null) continue;
      pages.set(ref.slug, fingerprint(raw));
      links += extractWikilinks(raw).length;
    }
  }
  return { pages, links };
}

/** Length + a cheap rolling sum. Enough to notice an edit; not a security hash. */
function fingerprint(text: string): string {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return `${text.length}:${sum.toString(36)}`;
}

// The link syntax itself needs no filesystem, and the chat renders answers in
// the browser. It lives in wikilinks.ts and is handed on from here.
export { extractWikilinks, linkifyWikilinks };

/** title → slug, for wikilink resolution. */
export async function titleIndex(cluster: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const grouped = await listPages(cluster);
  for (const dir of PAGE_DIRS) {
    for (const ref of grouped[dir]) {
      map.set(ref.title.toLowerCase(), ref.slug);
      map.set(ref.slug.split('/')[1].replace(/-/g, ' ').toLowerCase(), ref.slug);
    }
  }
  return map;
}

async function pageTitle(cluster: string, slug: string, file: string): Promise<string> {
  const raw = await readIfPresent(clusterPath(cluster, `${slug}.md`));
  return (raw && headingOf(splitPage(raw).content)) ?? deSlug(file.replace(/\.md$/, ''));
}

function headingOf(content: string): string | null {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function deSlug(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export { path };
