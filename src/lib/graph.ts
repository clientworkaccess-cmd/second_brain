import type { Facet } from './facets';
import { isCatalogue, loadWiki } from './wiki';
import { pageHref, resolveLink } from './wikilinks';

/**
 * Turns a wiki's pages and their `[[wikilinks]]` into a node/link graph.
 *
 * This is the renderer-agnostic half of the graph view. The shape below, flat
 * `nodes` and `links` arrays with string ids, is the shape every graph library
 * expects, so swapping the renderer is a component change and not a rewrite.
 */

/** The folder of a page beside the index, and of a page nobody has written. */
export const ROOT = 'root';
export const MISSING = 'missing';

export interface GraphNode {
  id: string; // the page slug, e.g. "entities/warehouse-team"
  label: string;
  /** The folder the page is in, `root` for a page beside the index, `missing` for one that is linked but not written. */
  kind: string;
  degree: number;
  href: string | null;
  /** What the page is about, by facet. Empty for a page nobody has written. */
  facets: Record<string, string[]>;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Written pages nothing links to. The clearest curation smell there is. */
  orphans: string[];
  /** What to call each kind, in the order of the page tree. */
  kinds: { kind: string; label: string }[];
  /** The facets the pages can be grouped by, with the values the wiki allows. */
  facets: Facet[];
}

export async function buildGraph(cluster: string): Promise<Graph> {
  const wiki = await loadWiki(cluster);

  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const inbound = new Set<string>();

  // The index links to every page and the log names every page it touched.
  // Drawn, they would be two points with a line to everything.
  const pages = [...wiki.entries.values()].filter((entry) => !isCatalogue(entry.slug));

  for (const entry of pages) {
    nodes.set(entry.slug, {
      id: entry.slug,
      label: entry.title,
      kind: entry.dir || ROOT,
      degree: 0,
      href: pageHref(cluster, entry.slug),
      facets: entry.facets,
    });
  }

  for (const entry of pages) {
    for (const target of entry.links) {
      const slug = resolveLink(wiki.names, target);

      if (!slug) {
        // Linked but never written. Kept in the graph on purpose: a dangling
        // link is a curation signal, and hiding it would hide the problem.
        const id = `${MISSING}:${target.toLowerCase()}`;
        if (!nodes.has(id)) nodes.set(id, { id, label: target, kind: MISSING, degree: 0, href: null, facets: {} });
        links.push({ source: entry.slug, target: id });
        continue;
      }

      if (slug === entry.slug || !nodes.has(slug)) continue; // itself, or the index
      links.push({ source: entry.slug, target: slug });
      inbound.add(slug);
    }
  }

  const unique = dedupe(links);

  // Degree drives node size, so the hubs of the wiki are visible at a glance.
  for (const link of unique) {
    const source = nodes.get(link.source);
    const target = nodes.get(link.target);
    if (source) source.degree++;
    if (target) target.degree++;
  }

  const used = new Set([...nodes.values()].map((node) => node.kind));
  const kinds = [
    ...wiki.folders.map((folder) => ({ kind: folder.dir, label: folder.label })),
    { kind: ROOT, label: 'Beside the index' },
    { kind: MISSING, label: 'Not written yet' },
  ].filter((entry) => used.has(entry.kind));

  return {
    nodes: [...nodes.values()],
    links: unique,
    orphans: [...nodes.values()].filter((node) => node.kind !== MISSING && !inbound.has(node.id)).map((node) => node.id),
    kinds,
    facets: wiki.facets,
  };
}

/** Two pages referencing each other should draw one edge, not two. */
function dedupe(links: GraphLink[]): GraphLink[] {
  const seen = new Set<string>();
  const out: GraphLink[] = [];
  for (const link of links) {
    const key = [link.source, link.target].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}
