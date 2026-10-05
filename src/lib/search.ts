import { clusterPath } from './config';
import { readIfPresent } from './clusters';
import { PAGE_DIRS, listPages, splitPage } from './wiki';

/**
 * Search across the pages of one cluster.
 *
 * Plain text, every word has to appear, case does not matter. A cluster is tens
 * to a few hundred small files, so reading them on each search costs less than
 * keeping an index in step with an agent that writes behind our back.
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

  const grouped = await listPages(cluster);
  const hits: (SearchHit & { score: number })[] = [];

  for (const dir of PAGE_DIRS) {
    for (const ref of grouped[dir]) {
      const raw = await readIfPresent(clusterPath(cluster, `${ref.slug}.md`));
      if (raw === null) continue;

      const body = splitPage(raw).content;
      const title = ref.title.toLowerCase();
      const text = body.toLowerCase();
      if (!terms.every((term) => title.includes(term) || text.includes(term))) continue;

      const inTitle = terms.filter((term) => title.includes(term)).length;
      const mentions = terms.reduce((n, term) => n + count(text, term), 0);
      hits.push({ slug: ref.slug, title: ref.title, snippet: snippetOf(body, terms), score: inTitle * 1000 + mentions });
    }
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
  const flat = body
    .replace(/^#{1,6}\s+.*$/m, '') // the title is shown already
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, label?: string) => label ?? target)
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = flat.toLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((at) => at !== -1).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, first - 60);
  const to = Math.min(flat.length, first + 140);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}
