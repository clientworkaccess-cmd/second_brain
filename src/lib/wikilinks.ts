import { headingId } from './outline';

/**
 * `[[Page]]`, `[[Page|shown text]]`, `[[Page#Heading]]` and `![[Page]]`.
 *
 * Pure, with no Node imports, so the browser can use it too: the chat turns the
 * links in an answer into real ones as the answer arrives.
 *
 * What is inside a code block or a code span is text about links, not links,
 * and is left alone.
 */

const LINK = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

export interface Target {
  /** The page, as written. Empty for a link to a heading of the page it is on. */
  page: string;
  heading: string | null;
}

/** "Refund Policy#Edge cases" -> the page and the heading. A block reference (`^id`) is dropped. */
export function parseTarget(target: string): Target {
  const [before, ...after] = target.split('#');
  const heading = after.join('#').split('^')[0].trim();
  return { page: before.split('^')[0].trim(), heading: heading || null };
}

/**
 * The page a link means, from the names the wiki knows it by (lib/wiki.ts
 * builds that list: file names, titles, aliases).
 */
export function resolveLink(known: Map<string, string>, target: string): string | undefined {
  const page = parseTarget(target).page.toLowerCase();
  if (!page) return undefined;
  const bare = page.replace(/\.md$/, '');
  return known.get(bare) ?? known.get(bare.split('/').pop() ?? bare);
}

/** Apply `change` to everything that is not code. */
function outsideCode(text: string, change: (prose: string) => string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
      if (mark) {
        if (fence === null) fence = mark[0];
        else if (mark[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      // Odd pieces are code spans.
      return line
        .split(/(`+[^`]*`+)/)
        .map((piece, i) => (i % 2 === 1 ? piece : change(piece)))
        .join('');
    })
    .join('\n');
}

/**
 * The pages a text links to, each once. A page that mentions [[Warehouse Team]]
 * three times has one connection to it, not three, which is both the honest
 * reading of "new connections" and what stops a list of links rendering
 * duplicate keys.
 */
export function extractWikilinks(text: string): string[] {
  const seen = new Map<string, string>();
  outsideCode(text, (prose) => {
    for (const match of prose.matchAll(LINK)) {
      const { page } = parseTarget(match[2]);
      if (page && !seen.has(page.toLowerCase())) seen.set(page.toLowerCase(), page);
    }
    return prose;
  });
  return [...seen.values()];
}

/** The text with every link replaced by the words it shows. */
export function withoutLinks(text: string): string {
  return text.replace(LINK, (_all, _embed: string, target: string, label?: string) => (label ?? shownFor(parseTarget(target))).trim());
}

function shownFor(target: Target): string {
  if (!target.page) return target.heading ?? '';
  return target.heading ? `${target.page} › ${target.heading}` : target.page;
}

/**
 * Turn `[[Warehouse Team]]` into a real markdown link before handing the text
 * to the renderer. A link to a page that does not exist is kept and marked, so
 * that it renders as a visible dead link rather than a silent 404, which is the
 * signal the check after filing wants.
 */
export function linkifyWikilinks(text: string, cluster: string, known: Map<string, string>): string {
  return outsideCode(text, (prose) =>
    prose.replace(LINK, (_all, _embed: string, raw: string, label?: string) => {
      const target = parseTarget(raw);
      const shown = escapeLabel((label ?? shownFor(target)).trim());
      const anchor = target.heading ? `#${encodeURIComponent(headingId(target.heading))}` : '';

      if (!target.page) return `[${shown}](${anchor})`;
      const slug = resolveLink(known, target.page);
      return slug
        ? `[${shown}](${pageHref(cluster, slug)}${anchor})`
        : `[${shown}](/c/${cluster}?missing=${encodeURIComponent(target.page)})`;
    }),
  );
}

/** Where a page is read. Every part of the path is encoded, since a file name is whatever someone typed. */
export function pageHref(cluster: string, slug: string): string {
  const encoded = slug
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
  return `/c/${cluster}/${encoded}`;
}

const escapeLabel = (text: string): string => text.replace(/([\[\]])/g, '\\$1');
