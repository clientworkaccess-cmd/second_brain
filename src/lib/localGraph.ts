import type { Graph, GraphLink, GraphNode } from './graph';

/**
 * The neighbourhood of one page: the pages within `depth` links of it, in
 * either direction, and the links among them. Pure; the page view and the
 * panel beside it both use it. No Node imports.
 */
export function localGraph(graph: Graph, id: string, depth: number): Graph {
  const around = new Map<string, Set<string>>();
  const touch = (a: string, b: string): void => {
    if (!around.has(a)) around.set(a, new Set());
    around.get(a)!.add(b);
  };
  for (const link of graph.links) {
    touch(link.source, link.target);
    touch(link.target, link.source);
  }

  const kept = new Set<string>();
  if (graph.nodes.some((n) => n.id === id)) {
    let ring = new Set<string>([id]);
    kept.add(id);
    for (let step = 0; step < depth && ring.size > 0; step++) {
      const next = new Set<string>();
      for (const at of ring) {
        for (const near of around.get(at) ?? []) {
          if (!kept.has(near)) {
            kept.add(near);
            next.add(near);
          }
        }
      }
      ring = next;
    }
  }

  const nodes: GraphNode[] = graph.nodes.filter((n) => kept.has(n.id));
  const links: GraphLink[] = graph.links.filter((l) => kept.has(l.source) && kept.has(l.target));
  const linked = new Set<string>();
  for (const l of links) {
    linked.add(l.source);
    linked.add(l.target);
  }
  return {
    nodes,
    links,
    orphans: nodes.filter((n) => n.kind !== 'missing' && !linked.has(n.id)).map((n) => n.id),
    kinds: graph.kinds.filter((k) => nodes.some((n) => n.kind === k.kind)),
    facets: graph.facets,
  };
}
