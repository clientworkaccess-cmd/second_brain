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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
