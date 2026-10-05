/**
 * Images in pages: which files count, how `![[photo.png]]` and `![](../raw/assets/photo.png)`
 * find their file, and where the browser fetches it.
 *
 * Pure, and imported by the reading view, the editor and the server alike.
 * No Node imports.
 */

/** What is served as an image, by extension. Nothing else is. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export function imageType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : (IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null);
}

export const isImagePath = (name: string): boolean => imageType(name) !== null;

/** Where the browser fetches an image of a wiki. */
export function assetHref(cluster: string, rel: string): string {
  return `/api/asset?cluster=${encodeURIComponent(cluster)}&path=${encodeURIComponent(rel)}`;
}

/** What to write in a page for an image that was added: Obsidian's form, by file name. */
export function imageEmbed(rel: string): string {
  return `![[${rel.split('/').pop() ?? rel}]]`;
}

/**
 * The file an image target names, among the images the wiki has (paths
 * relative to the wiki's root, `/` separated).
 *
 * A target with a folder in it is a path: from the page's own folder first,
 * then from the root. A bare name is looked up by file name, case blind: one
 * in the page's own folder wins, then the shortest path (Obsidian's rule).
 * Nothing climbs above the root.
 */
export function resolveImagePath(images: readonly string[], target: string, fromDir = ''): string | null {
  const wanted = clean(target);
  if (!wanted || !isImagePath(wanted)) return null;
  const byPath = new Map(images.map((p) => [p.toLowerCase(), p]));

  if (wanted.includes('/')) {
    for (const base of [fromDir, '']) {
      const joined = joinRel(base, wanted);
      const hit = joined === null ? undefined : byPath.get(joined.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  const name = wanted.toLowerCase();
  const candidates = images.filter((p) => (p.split('/').pop() ?? '').toLowerCase() === name);
  if (candidates.length === 0) return null;
  const here = fromDir ? `${fromDir.toLowerCase()}/` : '';
  const inFolder = candidates.find((p) => (here ? p.toLowerCase().startsWith(here) && !p.slice(here.length).includes('/') : !p.includes('/')));
  if (inFolder) return inFolder;
  return candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/** A target as written, without the parts that say nothing: encoding, `./`, a leading `/`, a query or a heading. */
function clean(target: string): string {
  let t = target.trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    /* not encoded, then */
  }
  t = t.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^\.\//, '').replace(/^\/+/, '');
  return t;
}

/** `wiki/entities` + `../../raw/a.png` -> `raw/a.png`; null when it would climb above the root. */
function joinRel(base: string, rel: string): string | null {
  const out: string[] = base ? base.split('/').filter(Boolean) : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}
