import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, clusterPath } from './config';
import { commitCluster, ensureRepo } from './git';
import { inPages, type Layout } from './layout';
import { backlinksOf, forgetWiki, isCatalogue, loadWiki } from './wiki';
import { outsideCode, resolveLink, slugOfTitle } from './wikilinks';

/**
 * A page renamed or deleted by a person. Both make a restore point.
 *
 * A rename is a new title: the file name follows it (the rules say the file
 * name is the title's slug), the block and the heading say the new title, and
 * every link to the page in every other page and in the index is rewritten
 * the way links are written in this wiki. A link written as an alias of the
 * page still works, so it is left as it is.
 *
 * A delete takes the page out and its line out of the index. Pages that
 * linked to it keep their links, which then point nowhere, the way the check
 * page reports them; the caller is told how many there are before asking.
 */

export interface Renamed {
  from: string;
  to: string;
  title: string;
  /** The pages whose links were rewritten, the index among them. */
  rewritten: string[];
  commit: string | null;
}

export interface Deleted {
  slug: string;
  title: string;
  /** How many pages linked here. Their links now lead nowhere. */
  backlinks: number;
  indexUpdated: boolean;
  commit: string | null;
}

const LINK = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
const MAX_TITLE = 120;

/** How a link to a page is written in this wiki: by its file name, or by its name. */
function writtenAs(layout: Layout, slug: string, title: string): string {
  return layout.links === 'slug' ? (slug.split('/').pop() ?? slug) : title;
}

/** The written forms of a link that a rename makes wrong: the slug, the file name, the title, and the file name with spaces. Aliases are not among them. */
function formsOf(slug: string, title: string): Set<string> {
  const name = slug.split('/').pop() ?? slug;
  return new Set([slug, name, title, name.replace(/[-_]+/g, ' ')].map((s) => s.trim().toLowerCase()));
}

/**
 * Every link that `means` says points at the page, rewritten to `to`, when it
 * is written in one of the `forms` the rename makes wrong. The embed mark, the
 * heading and the alias stay. Null when nothing changed.
 */
export function rewriteLinks(text: string, forms: Set<string>, to: string, means: (target: string) => boolean): string | null {
  let changed = false;
  const out = outsideCode(text, (prose) =>
    prose.replace(LINK, (all: string, embed: string, target: string, alias?: string) => {
      const [page, ...rest] = target.split('#');
      const bare = page.trim().replace(/\.md$/i, '').toLowerCase();
      if (!forms.has(bare) && !forms.has(bare.split('/').pop() ?? bare)) return all;
      if (!means(target)) return all;
      changed = true;
      const sub = rest.length ? `#${rest.join('#')}` : '';
      return `${embed}[[${to}${sub}${alias !== undefined ? `|${alias}` : ''}]]`;
    }),
  );
  return changed ? out : null;
}

/** The page's own text with the new title in its block and in its heading. */
export function retitle(raw: string, oldTitle: string, title: string): string {
  const safe = /[:#"']/.test(title) ? JSON.stringify(title) : title;
  let text = raw;
  const block = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (block) {
    const inner = block[1];
    const next = /^title:.*$/m.test(inner) ? inner.replace(/^title:.*$/m, `title: ${safe}`) : `title: ${safe}\n${inner}`;
    text = text.slice(0, 4) + next + text.slice(4 + inner.length);
  }
  const heading = new RegExp(`^#[ \\t]+${escapeRegExp(oldTitle)}[ \\t]*$`, 'm');
  if (heading.test(text)) text = text.replace(heading, `# ${title}`);
  else if (!block) text = text.replace(/^#\s+.*$/m, `# ${title}`);
  return text;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function renamePage(cluster: string, slug: string, newTitle: string): Promise<Renamed> {
  const title = newTitle.trim();
  if (!title || title.length > MAX_TITLE) throw new HttpError(400, `A title is one to ${MAX_TITLE} characters`);
  const name = slugOfTitle(title);
  if (!name) throw new HttpError(400, 'That title leaves nothing for a file name');
  if (isCatalogue(slug)) throw new HttpError(400, 'The index and the log keep their names');

  const wiki = await loadWiki(cluster, { fresh: true });
  const entry = wiki.entries.get(slug);
  if (!entry) throw new HttpError(404, `No page at ${slug}`);
  const parent = slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : '';
  const to = parent ? `${parent}/${name}` : name;
  if (to !== slug) {
    const taken = [...wiki.entries.keys()].find((s) => s.toLowerCase() === to.toLowerCase());
    if (taken) throw new HttpError(409, `There is already a page called "${wiki.entries.get(taken)?.title ?? taken}" there`);
  }
  if (to === slug && title === entry.title) return { from: slug, to, title, rewritten: [], commit: null };

  const layout = wiki.layout;
  // The wiki as it was, kept, before anything is moved.
  await ensureRepo(cluster, layout);
  const forms = formsOf(slug, entry.title);
  const written = writtenAs(layout, to, title);
  const means = (target: string): boolean => resolveLink(wiki.names, target) === slug;

  // The page itself: its title, and any link it has to itself.
  const raw = await fs.readFile(entry.file, 'utf8');
  const own = retitle(raw, entry.title, title);
  const file = clusterPath(cluster, inPages(layout, `${to}.md`));
  if (file !== entry.file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // A change of case only is a rename in place: on Windows the two names are one file.
    if (file.toLowerCase() === entry.file.toLowerCase()) await fs.rename(entry.file, file);
  }
  await writeWhole(file, rewriteLinks(own, forms, written, means) ?? own);
  if (file !== entry.file && file.toLowerCase() !== entry.file.toLowerCase()) await fs.rm(entry.file, { force: true });

  // Every other page that links here, the index among them.
  const rewritten: string[] = [];
  for (const other of wiki.entries.values()) {
    if (other.slug === slug || !other.links.some(means)) continue;
    const text = await fs.readFile(other.file, 'utf8');
    const next = rewriteLinks(text, forms, written, means);
    if (next === null) continue;
    await writeWhole(other.file, next);
    rewritten.push(other.slug);
  }

  forgetWiki(cluster);
  await loadWiki(cluster, { fresh: true });
  const commit = await commitCluster(cluster, `Rename ${entry.title} to ${title}`, layout);
  return { from: slug, to, title, rewritten, commit };
}

export async function deletePage(cluster: string, slug: string): Promise<Deleted> {
  if (isCatalogue(slug)) throw new HttpError(400, 'The index and the log are not deleted');
  const wiki = await loadWiki(cluster, { fresh: true });
  const entry = wiki.entries.get(slug);
  if (!entry) throw new HttpError(404, `No page at ${slug}`);
  const backlinks = (await backlinksOf(cluster, slug)).length;

  await ensureRepo(cluster, wiki.layout);
  await fs.rm(entry.file, { force: true });

  // Its line in the index, when the index lists it in a list or a table.
  let indexUpdated = false;
  const index = wiki.entries.get('index');
  if (index) {
    const means = (target: string): boolean => resolveLink(wiki.names, target) === slug;
    const lines = (await fs.readFile(index.file, 'utf8')).split('\n');
    const kept = lines.filter((line) => !(/^\s*([-*+]|\d+\.|\|)\s/.test(line) && [...line.matchAll(LINK)].some((m) => means(m[2]))));
    if (kept.length !== lines.length) {
      await writeWhole(index.file, kept.join('\n'));
      indexUpdated = true;
    }
  }

  forgetWiki(cluster);
  await loadWiki(cluster, { fresh: true });
  const commit = await commitCluster(cluster, `Delete ${entry.title}`, wiki.layout);
  return { slug, title: entry.title, backlinks, indexUpdated, commit };
}

/** Written beside and moved into place, so that a page is never half written. */
async function writeWhole(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, file);
}
