import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { HttpError, clusterPath } from './config';
import { readIfPresent } from './clusters';

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

  const { content } = matter(raw);
  const stat = await fs.stat(file);

  return {
    slug,
    dir: dir as PageDir,
    title: headingOf(content) ?? deSlug(rest[0]),
    body: content.trim(),
    updatedAt: stat.mtime.toISOString(),
    links: extractWikilinks(content),
  };
}

/** index.md is the agent's own catalog — the entry point for both a human
 *  browsing and the agent answering. */
export async function readIndex(cluster: string): Promise<string | null> {
  return readIfPresent(clusterPath(cluster, 'index.md'));
}

export interface LogEntry {
  raw: string;
  when: string | null;
}

/** log.md is append-only. We read the tail for the activity feed, and parse the
 *  most recent entry for the ingest diff. */
export async function readLog(cluster: string, limit = 20): Promise<LogEntry[]> {
  const raw = await readIfPresent(clusterPath(cluster, 'log.md'));
  if (!raw) return [];
  return raw
    .split(/\n(?=[-*#]\s|\d{4}-\d{2}-\d{2})/)
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse()
    .slice(0, limit)
    .map((entry) => ({ raw: entry, when: entry.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null }));
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

const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Deduplicated. A page that mentions [[Warehouse Team]] three times has one
 * connection to it, not three — which is both the honest reading of "new
 * connections" on the diff screen and what stops the links footer rendering
 * duplicate keys.
 */
export function extractWikilinks(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1].trim();
    if (!seen.has(target.toLowerCase())) seen.set(target.toLowerCase(), target);
  }
  return [...seen.values()];
}

/**
 * Turn `[[Warehouse Team]]` into a real markdown link before handing the text
 * to the renderer. Resolution is by title against the pages that exist, so a
 * link the agent invented but never wrote renders as a visible dead link rather
 * than a silent 404 — which is exactly the signal the post-ingest lint wants.
 */
export function linkifyWikilinks(text: string, cluster: string, known: Map<string, string>): string {
  return text.replace(WIKILINK, (_all, target: string, label?: string) => {
    const key = target.trim().toLowerCase();
    const slug = known.get(key);
    const text_ = (label ?? target).trim();
    return slug
      ? `[${text_}](/c/${cluster}/${slug})`
      : `[${text_}](/c/${cluster}?missing=${encodeURIComponent(target.trim())})`;
  });
}

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
  return (raw && headingOf(matter(raw).content)) ?? deSlug(file.replace(/\.md$/, ''));
}

function headingOf(content: string): string | null {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function deSlug(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export { path };
