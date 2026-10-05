import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, clusterPath } from './config';
import { readIfPresent } from './files';
import { dayOf, facetsOf, pageProblems, type Facet } from './facets';
import { propertiesOf, splitPage as splitBlock } from './frontmatter';
import { INDEX, LOG, indexFile, isPageFolder, labelOf, layoutOf, logFile, type Layout, type PageType } from './layout';
import { extractWikilinks, linkifyWikilinks, resolveLink, withoutLinks } from './wikilinks';

/**
 * Read-side of the wiki. The app never writes a page: that is the agent's job.
 * Everything here is read-only navigation over what it produced.
 *
 * A wiki is read once and then kept in memory. Every call looks at the folders
 * again, which is cheap, and reads only the files whose size or time changed.
 * A page view used to read every file of the wiki several times over; with a
 * few hundred pages that is thousands of reads for one click.
 */

export interface PageRef {
  /** The page's path from the folder the pages are in, without `.md`: "entities/warehouse-team", "overview". */
  slug: string;
  /** The folder. Empty for a page beside the index. */
  dir: string;
  title: string;
  /** What the page says it is about, by facet: `{ business: ['harbour-bakery'], area: ['finance'] }`. */
  facets: Record<string, string[]>;
}

export interface Page extends PageRef {
  /** `type:` from the block at the top, when the page says. */
  type: string | null;
  body: string;
  updatedAt: string;
  links: string[];
  /** The block at the top of the page, in the order it was written. Empty when there is none. */
  properties: [name: string, value: string][];
  /** What is wrong with that block, in the reader's words. Empty when nothing is. */
  problems: string[];
}

export interface Folder extends PageType {
  pages: PageRef[];
}

/** The pages of a wiki, as the page tree shows them. */
export interface Listing {
  layout: Layout['id'];
  /** The facets pages carry, with the values the wiki allows. Empty in a cluster. */
  facets: Facet[];
  folders: Folder[];
  /** The pages beside the index, the index and the log among them. */
  root: PageRef[];
  /** Every page except the index and the log. */
  total: number;
}

export interface Backlink {
  slug: string;
  title: string;
  /** The line the link sits in, so the reader sees why the page is mentioned. */
  context: string;
}

interface Entry extends PageRef {
  file: string;
  type: string | null;
  aliases: string[];
  data: Record<string, unknown>;
  body: string;
  /** What the page links to, as written. */
  links: string[];
  fingerprint: string;
  mtimeMs: number;
  size: number;
}

export interface Wiki {
  layout: Layout;
  /** The layout's folders, then any other folder that holds pages. */
  folders: PageType[];
  /** Every page by its slug, in the order of the page tree. */
  entries: Map<string, Entry>;
  /** Everything a page is known by, in lower case: file name, title, aliases. */
  names: Map<string, string>;
  /** The facets of the wiki, read from its rules and its registry. */
  facets: Facet[];
}

// ------------------------------------------------------------------ reading

interface Kept {
  wiki: Wiki | null;
  at: number;
  loading: Promise<Wiki> | null;
}

/** For how long a wiki that was just looked at is not looked at again. One page view asks several times. */
const SETTLED_MS = 300;

// On globalThis for the same reason as the jobs: route handlers are compiled
// into separate bundles, and each would otherwise keep its own copy.
const globalForWiki = globalThis as typeof globalThis & { __wikiPages?: Map<string, Kept> };
const kept: Map<string, Kept> = (globalForWiki.__wikiPages ??= new Map());

/**
 * The wiki as it is on disk.
 *
 * `fresh` looks again even when it has just looked. Anything that compares
 * before with after asks for that; a page view does not need it.
 */
export async function loadWiki(cluster: string, options: { fresh?: boolean } = {}): Promise<Wiki> {
  const key = clusterPath(cluster);
  let slot = kept.get(key);
  if (!slot) {
    slot = { wiki: null, at: 0, loading: null };
    kept.set(key, slot);
  }
  if (slot.loading) {
    const running = await slot.loading;
    if (!options.fresh) return running;
  }
  if (!options.fresh && slot.wiki && Date.now() - slot.at < SETTLED_MS) return slot.wiki;

  const current = slot;
  current.loading = scan(cluster, current.wiki).finally(() => {
    current.loading = null;
  });
  current.wiki = await current.loading;
  current.at = Date.now();
  return current.wiki;
}

/** Names an agent reads as instructions. Never pages, whatever folder they are in. */
const NOT_PAGES = new Set(['claude.md', 'claude.local.md', 'agents.md']);
const MAX_DEPTH = 4;
/** How many files are looked at together. Enough to be quick, few enough to leave file handles for everyone else. */
const AT_A_TIME = 48;

async function scan(cluster: string, previous: Wiki | null): Promise<Wiki> {
  const layout = await layoutOf(cluster);
  const pagesRoot = clusterPath(cluster, layout.pagesDir);
  const before = new Map([...(previous?.entries.values() ?? [])].map((entry) => [entry.file, entry]));

  const found: { slug: string; dir: string; file: string }[] = [];
  const others: string[] = [];

  for (const entry of await list(pagesRoot)) {
    if (entry.isFile()) {
      if (!isPageFile(entry.name)) continue;
      if (layout.pagesDir === '' && entry.name === layout.rulesFile) continue;
      found.push({ slug: stem(entry.name), dir: '', file: path.join(pagesRoot, entry.name) });
    } else if (entry.isDirectory() && isPageFolder(layout, entry.name) && !layout.types.some((t) => t.dir === entry.name)) {
      others.push(entry.name);
    }
  }

  const walk = async (dir: string, folder: string, rel: string, depth: number): Promise<number> => {
    let count = 0;
    for (const entry of await list(dir)) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) count += await walk(path.join(dir, entry.name), folder, relPath, depth + 1);
      } else if (entry.isFile() && isPageFile(entry.name)) {
        found.push({ slug: stem(relPath), dir: folder, file: path.join(dir, entry.name) });
        count++;
      }
    }
    return count;
  };

  const folders: PageType[] = [];
  for (const type of layout.types) {
    await walk(path.join(pagesRoot, type.dir), type.dir, type.dir, 1);
    folders.push(type);
  }
  // A folder no layout names still holds pages someone wrote. They are shown.
  for (const dir of others.sort((a, b) => a.localeCompare(b))) {
    const count = await walk(path.join(pagesRoot, dir), dir, dir, 1);
    if (count > 0) folders.push({ type: dir, dir, label: labelOf(dir), holds: '' });
  }

  // Looked at several at a time. One after the other, a few hundred pages take
  // a third of a second just to be asked whether they changed.
  const entries = new Map<string, Entry>();
  const look = async (item: (typeof found)[number]): Promise<void> => {
    const stat = await fs.stat(item.file).catch(() => null);
    if (!stat) return; // gone between the listing and now
    const was = before.get(item.file);
    const entry =
      was && was.mtimeMs === stat.mtimeMs && was.size === stat.size && was.slug === item.slug
        ? was
        : await readEntry(item, stat.mtimeMs, stat.size);
    if (entry) entries.set(entry.slug, entry);
  };
  for (let at = 0; at < found.length; at += AT_A_TIME) {
    await Promise.all(found.slice(at, at + AT_A_TIME).map(look));
  }

  const ordered = inTreeOrder(entries, folders);
  const rules = await readIfPresent(clusterPath(cluster, layout.rulesFile));
  const registry = ordered.get('businesses')?.body ?? null;
  return { layout, folders, entries: ordered, names: namesOf(entries), facets: facetsOf(layout, rules, registry) };
}

async function list(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // a folder may not exist until the agent creates it
  }
}

/** How many page files have been read from disk since the server started. The checks hold the cache to this. */
let filesRead = 0;
export function pagesRead(): number {
  return filesRead;
}

async function readEntry(item: { slug: string; dir: string; file: string }, mtimeMs: number, size: number): Promise<Entry | null> {
  filesRead++;
  const raw = await readIfPresent(item.file);
  if (raw === null) return null;
  const { content, data } = splitBlock(raw);
  const name = item.slug.split('/').pop() ?? item.slug;
  return {
    ...item,
    title: words(data.title) ?? headingOf(content) ?? deSlug(name),
    type: words(data.type)?.toLowerCase() ?? null,
    aliases: listOf(data.aliases ?? data.alias),
    facets: facetsIn(data),
    data,
    body: content.trim(),
    links: extractWikilinks(raw),
    fingerprint: fingerprint(raw),
    mtimeMs,
    size,
  };
}

/** Root pages first, then folder by folder, each by title. */
function inTreeOrder(entries: Map<string, Entry>, folders: PageType[]): Map<string, Entry> {
  const order = new Map<string, number>([['', 0], ...folders.map((f, i): [string, number] => [f.dir, i + 1])]);
  const sorted = [...entries.values()].sort(
    (a, b) => (order.get(a.dir) ?? 99) - (order.get(b.dir) ?? 99) || a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug),
  );
  return new Map(sorted.map((entry) => [entry.slug, entry]));
}

/**
 * What each page is known by. A file name beats a title, a title beats an
 * alias, and of two pages with the same name the one earlier in the tree wins.
 */
function namesOf(entries: Map<string, Entry>): Map<string, string> {
  const names = new Map<string, string>();
  const add = (name: string, slug: string): void => {
    const key = name.trim().toLowerCase();
    if (key && !names.has(key)) names.set(key, slug);
  };
  const all = [...entries.values()];
  for (const entry of all) add(entry.slug, entry.slug);
  for (const entry of all) add(fileName(entry.slug), entry.slug);
  for (const entry of all) add(entry.title, entry.slug);
  for (const entry of all) for (const alias of entry.aliases) add(alias, entry.slug);
  for (const entry of all) add(fileName(entry.slug).replace(/[-_]+/g, ' '), entry.slug);
  return names;
}

// ------------------------------------------------------------------- asking

/** Every page of a wiki, grouped for the page tree. */
export async function listPages(cluster: string): Promise<Listing> {
  return listingOf(await loadWiki(cluster));
}

export function listingOf(wiki: Wiki): Listing {
  const all = [...wiki.entries.values()];
  const ref = ({ slug, dir, title, facets }: Entry): PageRef => ({ slug, dir, title, facets });
  const folders = wiki.folders.map((folder) => ({ ...folder, pages: all.filter((e) => e.dir === folder.dir).map(ref) }));
  const root = all.filter((e) => e.dir === '').map(ref);
  return {
    layout: wiki.layout.id,
    facets: wiki.facets,
    folders,
    root,
    total: folders.reduce((n, folder) => n + folder.pages.length, 0) + root.filter((p) => !isCatalogue(p.slug)).length,
  };
}

/** The index and the log: kept by the agent about the wiki, rather than part of what the wiki says. */
export function isCatalogue(slug: string): boolean {
  return slug === INDEX || slug === LOG;
}

export async function readPage(cluster: string, slug: string): Promise<Page> {
  const parts = slug.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) {
    throw new HttpError(400, 'Malformed page slug');
  }
  // Only what the listing found can be opened, so a slug cannot name a file
  // that is not a page. A page that is not there may have been written a
  // moment ago: look again before saying so.
  let wiki = await loadWiki(cluster);
  if (!wiki.entries.has(slug)) wiki = await loadWiki(cluster, { fresh: true });
  const entry = wiki.entries.get(slug);
  if (!entry) throw new HttpError(404, `No page at ${slug}`);

  return {
    slug: entry.slug,
    dir: entry.dir,
    title: entry.title,
    type: entry.type,
    facets: entry.facets,
    body: entry.body,
    updatedAt: dayOf(entry.data.updated) ?? new Date(entry.mtimeMs).toISOString(),
    links: entry.links,
    properties: propertiesOf(entry.data),
    problems: pageProblems(entry, wiki.layout, wiki.facets),
  };
}

/** Every page that links to this one, with the line the link is in. */
export async function backlinksOf(cluster: string, slug: string): Promise<Backlink[]> {
  const wiki = await loadWiki(cluster);
  const out: Backlink[] = [];

  for (const entry of wiki.entries.values()) {
    // The index links to every page. That is its job, not a mention.
    if (entry.slug === slug || isCatalogue(entry.slug)) continue;
    if (!entry.links.some((target) => resolveLink(wiki.names, target) === slug)) continue;

    const line =
      entry.body.split('\n').find((candidate) => extractWikilinks(candidate).some((target) => resolveLink(wiki.names, target) === slug)) ??
      '';
    out.push({
      slug: entry.slug,
      title: entry.title,
      // Without the marks of a list, a quote, a heading or a table row.
      context: withoutLinks(line)
        .replace(/^[\s>#*|-]+|[\s|]+$/g, '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/`/g, '')
        .trim()
        .slice(0, 240),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** What every page is known by -> its slug, for resolving links. */
export async function linkIndex(cluster: string): Promise<Map<string, string>> {
  return (await loadWiki(cluster)).names;
}

/**
 * The index is the agent's own catalogue: the entry point for a person
 * browsing and for the agent answering.
 */
export async function readIndex(cluster: string): Promise<string | null> {
  return readIfPresent(clusterPath(cluster, indexFile(await layoutOf(cluster))));
}

export interface LogEntry {
  /** YYYY-MM-DD, as written. */
  when: string;
  /** ingest, update, query, lint, create, archive, delete or schema. */
  action: string;
  subject: string;
  /** The lines under the entry: what was created or changed. */
  details: string[];
}

/**
 * The entries of the log, newest first.
 *
 * An entry is a `## [YYYY-MM-DD] action | subject` line and the lines under
 * it. Everything above the first entry is the file's own explanation of its
 * format and is left out.
 */
export async function readLog(cluster: string, limit = 20): Promise<LogEntry[]> {
  const raw = await readIfPresent(clusterPath(cluster, logFile(await layoutOf(cluster))));
  if (!raw) return [];

  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    const head = line.match(/^#{1,6}\s*\[(\d{4}-\d{2}-\d{2})\]\s*([A-Za-z-]+)\s*\|\s*(.+?)\s*$/);
    if (head) {
      entries.push({ when: head[1], action: head[2].toLowerCase(), subject: withoutLinks(head[3]), details: [] });
      continue;
    }
    const detail = withoutLinks(line.replace(/^[\s>*-]+/, '')).trim();
    if (detail && entries.length > 0 && !line.startsWith('#')) entries[entries.length - 1].details.push(detail);
  }
  return entries.reverse().slice(0, limit);
}

/** The text of every page, for the search. */
export async function pageTexts(cluster: string): Promise<{ slug: string; dir: string; title: string; body: string }[]> {
  const wiki = await loadWiki(cluster);
  return [...wiki.entries.values()].filter((e) => !isCatalogue(e.slug)).map(({ slug, dir, title, body }) => ({ slug, dir, title, body }));
}

// ------------------------------------------------------- before and after

export interface IngestDiff {
  newPages: number;
  updatedPages: number;
  newConnections: number;
}

/**
 * What the wiki held at one moment. The numbers a filing reports are read from
 * the disk with this, rather than taken from what the agent says it did.
 */
export interface Snapshot {
  /** slug -> a cheap fingerprint of the file, so "updated" means the bytes changed */
  pages: Map<string, string>;
  links: number;
}

export async function snapshot(cluster: string): Promise<Snapshot> {
  const wiki = await loadWiki(cluster, { fresh: true });
  const pages = new Map<string, string>();
  let links = 0;
  for (const entry of wiki.entries.values()) {
    if (isCatalogue(entry.slug)) continue;
    pages.set(entry.slug, entry.fingerprint);
    links += entry.links.length;
  }
  return { pages, links };
}

export async function diffAgainst(cluster: string, before: Snapshot): Promise<IngestDiff> {
  const after = await snapshot(cluster);
  let newPages = 0;
  let updatedPages = 0;

  for (const [slug, print] of after.pages) {
    const previous = before.pages.get(slug);
    if (previous === undefined) newPages++;
    else if (previous !== print) updatedPages++;
  }

  return { newPages, updatedPages, newConnections: Math.max(0, after.links - before.links) };
}

/** Length and a cheap rolling sum. Enough to notice an edit; not a security hash. */
export function fingerprint(text: string): string {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return `${text.length}:${sum.toString(36)}`;
}

// ------------------------------------------------------------------ helpers

/**
 * A page split into the block at its top and the text below it. The agent
 * writes that block, so it can be malformed; such a page is shown whole.
 */
export function splitPage(raw: string): { content: string; properties: [string, string][] } {
  const { content, data } = splitBlock(raw);
  return { content, properties: propertiesOf(data) };
}

const isPageFile = (name: string): boolean => /\.md$/i.test(name) && !NOT_PAGES.has(name.toLowerCase());
const stem = (name: string): string => name.replace(/\.md$/i, '');
const fileName = (slug: string): string => slug.split('/').pop() ?? slug;

function headingOf(content: string): string | null {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function deSlug(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A value from the block as text, when it is one. */
function words(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

/** `[a, b]`, `a, b` and `a` are all lists. */
export function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => words(item)).filter((item): item is string => item !== null);
  const text = words(value);
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

/** The facet values a block gives, by key. Only the keys a wiki uses are read (see lib/facets.ts); the rest is properties. */
function facetsIn(data: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of ['business', 'area']) {
    if (key in data) out[key] = listOf(data[key]).map((value) => value.toLowerCase());
  }
  return out;
}

// The link syntax itself needs no filesystem, and the chat renders answers in
// the browser. It lives in wikilinks.ts and is handed on from here.
export { extractWikilinks, linkifyWikilinks, resolveLink };
