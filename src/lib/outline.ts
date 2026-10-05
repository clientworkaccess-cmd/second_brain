/**
 * The headings of a page, for the outline panel.
 *
 * Pure, and shared by the places that must agree: the panel that links to a
 * heading, the reading view that gives the heading its id, and a link that
 * points at a heading of another page. All take the ids from here, so they
 * cannot disagree.
 */

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export function outlineOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  const used = new Map<string, number>();
  let fence: string | null = null;

  for (const line of markdown.split('\n')) {
    // A `#` inside a code block is a comment, not a heading.
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1] ?? null;
    if (mark) {
      if (fence === null) fence = mark[0];
      else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const text = plain(match[2]);
    if (!text) continue;
    const base = headingId(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out.push({ depth: match[1].length, text, id: seen === 0 ? base : `${base}-${seen + 1}` });
  }
  return out;
}

/** "The **Warehouse** [[Team]]" -> "The Warehouse Team". */
function plain(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, label?: string) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

/** "Edge cases" -> "edge-cases". The id of the first heading with those words. */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'section'
  );
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}
