import type { Graph, GraphLink, GraphNode } from './graph';

/**
 * Pages kept out of the graph by the person looking at it: whole folders
 * (the sources, say), single pages beside the index (the overview), and
 * patterns typed in. Pure; the view applies it in the browser and remembers
 * the choice per wiki. The index and the log are never drawn in the first
 * place (lib/graph.ts). No Node imports.
 */

export interface Hidden {
  /** Folders, by the `kind` the graph gives their pages: `sources`, `entities`, …; `root` for pages beside the index. */
  folders: string[];
  /** Single pages, by slug. */
  pages: string[];
  /**
   * Patterns, one per entry: a slug or a prefix (`sources/`), with `*` for
   * anything. Matched against the slug and against the title, without
   * regard to case.
   */
  patterns: string[];
}

export const NOTHING_HIDDEN: Hidden = { folders: [], pages: [], patterns: [] };

/** The patterns as typed: commas or line breaks between them, blanks dropped. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function matcher(pattern: string): (value: string) => boolean {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  // A prefix ending in `/` names a folder and everything under it; anything else is a whole slug or title.
  const re = pattern.endsWith('/') ? new RegExp(`^${escaped}`) : new RegExp(`^${escaped}$`);
  return (value) => re.test(value.toLowerCase());
}

export function isHidden(node: Pick<GraphNode, 'id' | 'kind' | 'label'>, hidden: Hidden, tests: ((v: string) => boolean)[] = hidden.patterns.map(matcher)): boolean {
  if (node.kind !== 'missing' && hidden.folders.includes(node.kind)) return true;
  if (hidden.pages.includes(node.id)) return true;
  const slug = node.kind === 'missing' ? node.label : node.id;
  return tests.some((test) => test(slug) || test(node.label));
}

/** The graph without the hidden pages, the links that touched them, and the missing pages nothing links to any more. */
export function hideFrom(graph: Graph, hidden: Hidden): Graph {
  if (hidden.folders.length === 0 && hidden.pages.length === 0 && hidden.patterns.length === 0) return graph;
  const tests = hidden.patterns.map(matcher);
  const kept = new Set(graph.nodes.filter((n) => !isHidden(n, hidden, tests)).map((n) => n.id));
  const links: GraphLink[] = graph.links.filter((l) => kept.has(l.source) && kept.has(l.target));
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  // A page nobody has written is only there because something links to it.
  const nodes: GraphNode[] = graph.nodes
    .filter((n) => kept.has(n.id) && (n.kind !== 'missing' || (degree.get(n.id) ?? 0) > 0))
    .map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
  const inbound = new Set(links.map((l) => l.target));
  for (const l of links) inbound.add(l.source);
  return {
    nodes,
    links,
    orphans: nodes.filter((n) => n.kind !== 'missing' && !inbound.has(n.id)).map((n) => n.id),
    kinds: graph.kinds.filter((k) => nodes.some((n) => n.kind === k.kind)),
    facets: graph.facets,
  };
}
