import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, clusterPath } from './config';
import { commitCluster } from './git';
import { inPages, isPageFolder, layoutOf } from './layout';
import { loadWiki } from './wiki';

/**
 * A person writing a page. The one place the app writes into a wiki's pages.
 *
 * The agent writes through its own tools; this is for the editor. Two rules:
 * a page is a `.md` file in the folder the pages are in, or in one of its
 * folders, and nothing else can be written this way; and a page that changed
 * on disk since it was opened is not overwritten without the writer being told.
 */

export interface PageSource {
  slug: string;
  text: string;
  /** What the file was when it was read. A save gives it back, and is refused if the file moved on. */
  version: string;
  exists: boolean;
}

/** Names an agent reads as instructions. Never written as pages, whatever folder they are in. */
const NOT_PAGES = new Set(['claude.md', 'claude.local.md', 'agents.md']);
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** The file a slug names, or an error a reader can act on. */
async function fileOf(cluster: string, slug: string): Promise<{ file: string; name: string }> {
  const parts = slug.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part) || part.startsWith('.'))) {
    throw new HttpError(400, 'Malformed page slug');
  }
  const layout = await layoutOf(cluster);
  const name = parts[parts.length - 1];
  if (NOT_PAGES.has(`${name}.md`.toLowerCase()) || (layout.pagesDir === '' && `${name}.md` === layout.rulesFile)) {
    throw new HttpError(400, 'That is not a page');
  }
  if (parts.length > 1 && !isPageFolder(layout, parts[0])) {
    throw new HttpError(400, `Pages are not kept in "${parts[0]}"`);
  }
  return { file: clusterPath(cluster, inPages(layout, ...parts.slice(0, -1), `${name}.md`)), name };
}

async function versionOf(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return null;
  }
}

export async function readPageSource(cluster: string, slug: string): Promise<PageSource> {
  const { file } = await fileOf(cluster, slug);
  const version = await versionOf(file);
  if (version === null) return { slug, text: '', version: '', exists: false };
  return { slug, text: await fs.readFile(file, 'utf8'), version, exists: true };
}

/**
 * Write a page. `version` is what the writer read; a file that moved on since
 * is refused with what it holds now, unless `force`. `commit` makes a restore
 * point of the wiki afterwards, for the end of an editing session rather than
 * every keystroke.
 */
export async function writePageSource(
  cluster: string,
  slug: string,
  text: string,
  options: { version?: string; force?: boolean; commit?: boolean } = {},
): Promise<{ version: string; created: boolean; commit: string | null }> {
  if (Buffer.byteLength(text, 'utf8') > MAX_PAGE_BYTES) throw new HttpError(413, 'That page is too large');
  const { file } = await fileOf(cluster, slug);
  const before = await versionOf(file);

  if (before !== null && !options.force && (options.version ?? '') !== before) {
    const now = await fs.readFile(file, 'utf8');
    throw new PageMovedOn(before, now);
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  // Written beside and moved into place, so that a page is never half written.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, file);

  const version = (await versionOf(file)) ?? '';
  await loadWiki(cluster, { fresh: true });

  let commit: string | null = null;
  if (options.commit) commit = await commitCluster(cluster, `Edit ${slug} in the app`, await layoutOf(cluster));
  return { version, created: before === null, commit };
}

/**
 * What a new page starts as: the block the wiki's rules ask for, filled in as
 * far as the app can, and the title as a heading. The folder decides the type.
 */
export async function templateFor(cluster: string, slug: string, title: string): Promise<string> {
  const layout = await layoutOf(cluster);
  const folder = slug.includes('/') ? slug.split('/')[0] : '';
  const type = layout.types.find((t) => t.dir === folder)?.type ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const safe = /[:#"']/.test(title) ? JSON.stringify(title) : title;
  const lines = ['---', `title: ${safe}`];
  if (type) lines.push(`type: ${type}`);
  if (layout.id === 'brain') lines.push('business: []', 'area: []');
  lines.push('tags: []', 'sources: []', `created: ${today}`, `updated: ${today}`, 'confidence: medium', '---', '', `# ${title}`, '', '');
  return lines.join('\n');
}

/** Thrown when a save is refused because the page changed since it was read. Carries the page as it is. */
export class PageMovedOn extends HttpError {
  constructor(
    readonly version: string,
    readonly text: string,
  ) {
    super(409, 'This page changed on disk since you opened it.');
  }
}
