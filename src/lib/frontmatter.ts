import matter from 'gray-matter';

/**
 * The block at the top of a page.
 *
 * Read as YAML and as nothing else. The parser behind this can read a block in
 * other formats when the block's first line names one. A page is data, written
 * by an agent that reads documents nobody here wrote, so the format is not the
 * page's to choose: a block that names one is not read as a block at all, and
 * the page is shown whole.
 *
 * This is the only file that calls the parser. `npm run check:pages` holds it
 * to that.
 */

export interface SplitPage {
  /** The page without its block. The whole page when it has no block, or none that can be read. */
  content: string;
  /** What the block holds. Empty when there is none. */
  data: Record<string, unknown>;
}

/** More than any page needs, and small enough that reading a block cannot be made expensive. */
const MAX_BLOCK_BYTES = 32 * 1024;

const refuse = (): never => {
  throw new Error('The block at the top of a page is read as YAML only');
};

// The second layer under the test of the first line below. Every format the
// parser knows besides YAML, by each name it answers to.
const YAML_ONLY = {
  language: 'yaml',
  engines: {
    javascript: refuse,
    js: refuse,
    coffee: refuse,
    coffeescript: refuse,
    cson: refuse,
    json: refuse,
  },
};

export function splitPage(raw: string): SplitPage {
  const whole: SplitPage = { content: raw, data: {} };
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // A block opens with three dashes and nothing after them.
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return whole;

  const close = text.indexOf('\n---', open[0].length - 1);
  if (close === -1 || close > MAX_BLOCK_BYTES) return whole;

  try {
    const parsed = matter(text, YAML_ONLY);
    return { content: parsed.content, data: isRecord(parsed.data) ? parsed.data : {} };
  } catch {
    // The agent writes the block, so it can be malformed. The page still opens.
    return whole;
  }
}

/** How much of a block is printed: more than any real one holds. */
const MAX_PROPERTIES = 100;
const MAX_VALUES = 2000;
const MAX_TEXT = 2000;

/**
 * What a block holds, as text for the reader, in the order it was written.
 *
 * Within limits. YAML lets one value stand for another, so a block of a few
 * lines can describe a value that is millions of items long once written out.
 * Reading such a block costs nothing. Printing it without a limit would.
 */
export function propertiesOf(data: Record<string, unknown>): [name: string, value: string][] {
  const budget = { left: MAX_VALUES };
  return Object.entries(data)
    .slice(0, MAX_PROPERTIES)
    .map(([name, value]) => [name, shown(value, budget, 0).slice(0, MAX_TEXT)]);
}

function shown(value: unknown, budget: { left: number }, depth: number): string {
  if (budget.left-- <= 0 || depth > 6) return '…';
  if (value === null || value === undefined) return '';
  // YAML reads 2026-09-28 as a date, and a date prints with a time and a zone.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return within(value, budget, (item) => shown(item, budget, depth + 1));
  if (isRecord(value)) {
    const inside = within(Object.entries(value), budget, ([key, item]) => `${key}: ${shown(item, budget, depth + 1)}`);
    return `{ ${inside} }`;
  }
  return String(value).slice(0, MAX_TEXT);
}

/** The items joined with commas, stopping where the budget or the length runs out. */
function within<T>(items: T[], budget: { left: number }, print: (item: T) => string): string {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    if (budget.left <= 0 || length > MAX_TEXT) {
      parts.push('…');
      break;
    }
    const text = print(item);
    parts.push(text);
    length += text.length + 2;
  }
  return parts.join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
