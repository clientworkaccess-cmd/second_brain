import type { Graph } from '@/lib/graph';
import { UNRESOLVED_GROUP, type GraphData } from './data';
import type { GraphPalette } from './webglGraph';

/**
 * What the engine is given: the page's colours, read from the CSS variables
 * so the graph follows the theme, and the wiki's graph in the engine's shape.
 * Shared by the whole-wiki graph and the local one beside a page.
 */

export function readPalette(host: HTMLElement): GraphPalette {
  const css = getComputedStyle(host);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    dark: getComputedStyle(document.documentElement).colorScheme.trim() === 'dark',
    node: v('--text-muted', '#999'),
    unresolved: v('--text-faint', '#666'),
    accent: v('--accent', '#0d9488'),
    link: v('--border', '#555'),
    label: v('--text-normal', '#ddd'),
    bg: css.backgroundColor || v('--bg-primary', '#1e1e1e'),
    font: v('--font-ui', 'sans-serif'),
  };
}

/** What the engine takes: the folder as the group, the chosen facet's values as the areas. */
export function toData(graph: Graph, facet: string | null): GraphData {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      unresolved: n.kind === 'missing',
      degree: n.degree,
      group: n.kind === 'missing' ? UNRESOLVED_GROUP : n.kind,
      areas: facet && n.kind !== 'missing' ? (n.facets[facet] ?? []) : [],
    })),
    links: graph.links.map((l) => ({ source: l.source, target: l.target, weight: 1 })),
  };
}
