import { pageTexts } from './wiki';
import { withoutLinks } from './wikilinks';

/**
 * Search across the pages of one wiki.
 *
 * Plain text, every word has to appear, case does not matter. The text of the
 * pages is already in memory (lib/wiki.ts), so a search reads nothing from disk
 * and needs no index of its own to keep in step with an agent that writes
 * behind our back.
 */

export interface SearchHit {
  slug: string;
  title: string;
  /** A stretch of the page around the first match, on one line. */
  snippet: string;
}

const MAX_TERMS = 8;

export async function searchCluster(cluster: string, query: string, limit = 30): Promise<SearchHit[]> {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
  if (terms.length === 0) return [];

  const hits: (SearchHit & { score: number })[] = [];

  for (const page of await pageTexts(cluster)) {
    const title = page.title.toLowerCase();
    const text = page.body.toLowerCase();
    if (!terms.every((term) => title.includes(term) || text.includes(term))) continue;

    const inTitle = terms.filter((term) => title.includes(term)).length;
    const mentions = terms.reduce((n, term) => n + count(text, term), 0);
    hits.push({ slug: page.slug, title: page.title, snippet: snippetOf(page.body, terms), score: inTitle * 1000 + mentions });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}

function count(text: string, term: string): number {
  let n = 0;
  for (let at = text.indexOf(term); at !== -1 && n < 50; at = text.indexOf(term, at + term.length)) n++;
  return n;
}

function snippetOf(body: string, terms: string[]): string {
  const flat = withoutLinks(body.replace(/^#{1,6}\s+.*$/m, '')) // the title is shown already
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = flat.toLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((at) => at !== -1).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, first - 60);
  const to = Math.min(flat.length, first + 140);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}
