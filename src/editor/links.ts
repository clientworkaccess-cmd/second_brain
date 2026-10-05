/**
 * The few things the editor needs to know about links and files. In the
 * desktop app these live in core/links.ts and shared/paths.ts; here they are
 * the same rules, kept small.
 */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

export function isExternalHref(href: string): boolean {
  return SCHEME_RE.test(href);
}

export function isImageFile(rel: string): boolean {
  const dot = rel.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTS.has(rel.slice(dot + 1).toLowerCase());
}

/** `Note#Heading|alias` -> parts. */
export function splitWikilink(inner: string): { target: string; heading?: string; block?: string; alias?: string } {
  const pipe = inner.indexOf('|');
  const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
  const ref = pipe === -1 ? inner : inner.slice(0, pipe);
  const hash = ref.indexOf('#');
  const target = (hash === -1 ? ref : ref.slice(0, hash)).trim();
  const sub = hash === -1 ? '' : ref.slice(hash + 1).trim();
  const out: { target: string; heading?: string; block?: string; alias?: string } = { target };
  if (sub.startsWith('^')) out.block = sub.slice(1);
  else if (sub) out.heading = sub;
  if (alias !== undefined) out.alias = alias;
  return out;
}

/** The key that turns a click on a link into following it: Cmd on a Mac, Ctrl elsewhere. */
export function hasFollowModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? e.metaKey : e.ctrlKey;
}

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
