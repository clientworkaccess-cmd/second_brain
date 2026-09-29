/**
 * `[[Page Name]]` and `[[Page Name|shown text]]`.
 *
 * Pure, with no Node imports, so the browser can use it too: the chat turns the
 * links in an answer into real ones as the answer arrives.
 */

export const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Deduplicated. A page that mentions [[Warehouse Team]] three times has one
 * connection to it, not three — which is both the honest reading of "new
 * connections" on the diff screen and what stops a list of links rendering
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
