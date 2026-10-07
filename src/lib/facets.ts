import type { Layout, PageType } from './layout';

/**
 * Facets: what a page is about, across the folders.
 *
 * A folder says what kind of page it holds and nothing else. In a brain every
 * page also says which business it concerns and what kind of work it is about,
 * in the block at its top:
 *
 *   business: [harbour-bakery]      values from the registry, wiki/businesses.md
 *   area: [finance, operations]     values from the fixed list in CLAUDE.md
 *
 * The values are the wiki's own. They are read from the wiki, never kept here,
 * so that a business added to the registry is known the moment it is added.
 * Only when the rules name no areas does the list built into the schema this
 * layout follows stand in.
 *
 * Pure. lib/wiki.ts hands it the two files; nothing here touches the disk.
 */

export interface FacetValue {
  /** As written in a page's block: `harbour-bakery`. */
  value: string;
  /** For a reader: "Harbour Bakery". */
  label: string;
  /** The page about it, when the registry names one: `harbour-bakery`. */
  page: string | null;
  note: string;
}

export interface Facet {
  /** The key in a page's block: `business`, `area`. */
  key: string;
  label: string;
  /** What a page may carry, in the order the wiki lists them. */
  values: FacetValue[];
  /** At most this many on one page. */
  max: number | null;
  /** Where the values come from, for a message: `wiki/businesses.md`. */
  source: string;
}

/** The areas of the schema a brain follows, used when its rules name none. */
export const AREAS_BY_DEFAULT = ['strategy', 'marketing', 'sales', 'operations', 'finance', 'people', 'product', 'technology', 'legal', 'customer'];

/** The values a page may give `confidence`. */
export const CONFIDENCE = ['high', 'medium', 'low'];

/**
 * The facets of a wiki. `rules` is its rules file and `registry` the page that
 * lists its businesses, both as text, either of which may be missing.
 */
export function facetsOf(layout: Layout, rules: string | null, registry: string | null): Facet[] {
  if (layout.id !== 'brain') return [];
  return [
    {
      key: 'business',
      label: 'Business',
      values: registry ? tableValues(registry) : [],
      max: null,
      source: 'wiki/businesses.md',
    },
    {
      key: 'area',
      label: 'Area',
      values: areasIn(rules) ?? AREAS_BY_DEFAULT.map((area) => ({ value: area, label: labelOf(area), page: null, note: '' })),
      max: 3,
      source: 'CLAUDE.md',
    },
  ];
}

/**
 * The rows of every table whose first cell is a value in backticks:
 *
 *   | `harbour-bakery` | Harbour Bakery | [[harbour-bakery]] | three shops |
 */
export function tableValues(markdown: string): FacetValue[] {
  const out: FacetValue[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const row = line.match(/^\s*\|\s*`([^`\s|]+)`\s*\|(.*)$/);
    if (!row) continue;
    const value = row[1].trim();
    if (seen.has(value)) continue;
    seen.add(value);
    // Cells are split on |, except inside a [[link|with a bar]].
    const cells = row[2].split(/\|(?![^[]*\]\])/).map((cell) => cell.trim());
    const page = cells.find((cell) => /^\[\[[^\]]+\]\]$/.test(cell))?.replace(/^\[\[|\]\]$/g, '').split('|')[0] ?? null;
    const label = cells.find((cell) => cell && !/^\[\[/.test(cell)) ?? labelOf(value);
    out.push({ value, label: label.replace(/[*_`]/g, ''), page, note: cells.filter((cell) => cell && cell !== label && !/^\[\[/.test(cell)).join(' · ') });
  }
  return out;
}

/** The areas a rules file lists, from the first table under a heading that mentions areas. Null when it has none. */
export function areasIn(rules: string | null): FacetValue[] | null {
  if (!rules) return null;
  const from = rules.search(/^#{1,6}[^\n]*\barea\b/im);
  if (from === -1) return null;
  // From the line after the heading to the next heading of the first or second level.
  // Counted from the heading's own line end: a `##` heading is itself such a heading.
  const body = rules.indexOf('\n', from);
  if (body === -1) return null;
  const to = rules.slice(body).search(/^#{1,2}\s/m);
  const section = rules.slice(body, to === -1 ? undefined : body + to);
  const values = tableValues(section).map((row) => ({ ...row, label: labelOf(row.value), note: row.label }));
  return values.length > 0 ? values : null;
}

/** "harbour-bakery" -> "Harbour Bakery". */
export function labelOf(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * What is wrong with the block at the top of a page, in the reader's words.
 * Empty when nothing is. A page is never refused for these; they are reported.
 */
export function pageProblems(
  page: { slug: string; dir: string; type: string | null; data: Record<string, unknown>; facets: Record<string, string[]> },
  layout: Layout,
  facets: Facet[],
): string[] {
  const out: string[] = [];
  const { data } = page;
  const folder: PageType | undefined = layout.types.find((t) => t.dir === page.dir);

  if (Object.keys(data).length === 0) {
    out.push('has no block at its top');
    return out;
  }
  if (typeof data.title !== 'string' || !data.title.trim()) out.push('has no title in its block');

  if (page.type === null) {
    out.push('has no type in its block');
  } else if (!layout.types.some((t) => t.type === page.type) && page.type !== folder?.type) {
    out.push(`has the type "${page.type}", which this wiki does not have`);
  } else if (folder && page.type !== folder.type) {
    out.push(`has the type "${page.type}" but is in the folder for ${folder.label.toLowerCase()}`);
  }

  for (const facet of facets) {
    const given = page.facets[facet.key] ?? [];
    if (!(facet.key in data)) {
      out.push(`has no ${facet.key}`);
      continue;
    }
    if (facet.values.length > 0) {
      const known = new Set(facet.values.map((v) => v.value));
      for (const value of given) {
        if (!known.has(value)) out.push(`has the ${facet.key} "${value}", which is not in ${facet.source}`);
      }
    }
    if (facet.max !== null && given.length > facet.max) out.push(`has ${given.length} ${facet.key}s; at most ${facet.max} are allowed`);
  }

  for (const key of ['created', 'updated']) {
    if (key in data && dayOf(data[key]) === null) out.push(`has a ${key} that is not a date (YYYY-MM-DD)`);
  }
  if ('confidence' in data && !CONFIDENCE.includes(String(data.confidence).toLowerCase())) {
    out.push(`has the confidence "${String(data.confidence)}"; it is high, medium or low`);
  }
  if (page.type === 'source' && !('date' in data)) out.push('is a source page without the date of its source');

  return out;
}

/** YAML reads 2026-09-28 as a date. Either way, the day, or null when it is neither. */
export function dayOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
