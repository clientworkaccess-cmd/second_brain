'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { RotateCcw } from 'lucide-react';
import type { Graph, GraphNode } from '@/lib/graph';

/**
 * The wiki as a graph: every page a node, every [[wikilink]] an edge.
 *
 * Laid out and coloured like the desktop app's graph: a header above, the
 * graph filling the pane, the legend in its corner, one colour per group. The
 * pages are grouped by folder, or by a facet the wiki has, such as the
 * business a page concerns: then a page with several is drawn as a pie, each
 * group pulls its pages toward a place of its own, and a link across groups
 * holds less. A row of the legend narrows the graph to one group.
 *
 * The desktop draws with WebGL because a vault reaches thousands of links; a
 * wiki here reaches hundreds of pages, where SVG is enough. The layout and the
 * data are separate (see lib/graph.ts), so the renderer can be swapped without
 * touching anything upstream.
 */

interface Node extends SimulationNodeDatum, GraphNode {}
interface Link {
  source: Node;
  target: Node;
}

/** How the pages are grouped: by folder, or by one of the wiki's facets. */
const FOLDERS = 'folders';

/**
 * One hue per group, spread by the golden angle over the group names in
 * alphabetical order. This is the desktop app's rule (core/graph.ts there), so
 * the same wiki gets the same kind of colours in both.
 */
function huesOf(groups: string[]): Map<string, number> {
  const sorted = [...new Set(groups)].filter((g) => g !== 'missing').sort((a, b) => a.localeCompare(b));
  return new Map(sorted.map((group, i) => [group, (i * 137.508) % 360]));
}

/** Up to this many pages, every one is labelled. */
const LABEL_ALL_UP_TO = 120;
/** Past that, the pages with the most links keep their labels. */
const LABELLED_HUBS = 30;
/** A page in more groups than this shows the first few. */
const MAX_SLICES = 4;

const colourOf = (hue: number | undefined): string =>
  hue === undefined ? 'var(--text-faint)' : `hsl(${Math.round(hue)} 62% var(--graph-lightness))`;

export function GraphView({ graph, cluster }: { graph: Graph; cluster: string }) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<Node, undefined> | null>(null);

  const [size, setSize] = useState({ width: 900, height: 600 });
  const [, setTick] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [mode, setMode] = useState<string>(FOLDERS);
  const [focus, setFocus] = useState<string | null>(null);

  // The grouping is remembered per wiki, as the desktop app remembers its area view.
  useEffect(() => {
    try {
      const kept = localStorage.getItem(`sb-graph-mode:${cluster}`);
      if (kept && (kept === FOLDERS || graph.facets.some((f) => f.key === kept))) setMode(kept);
    } catch {
      /* the default, then */
    }
  }, [cluster, graph.facets]);
  const chooseMode = (next: string): void => {
    setMode(next);
    setFocus(null);
    try {
      localStorage.setItem(`sb-graph-mode:${cluster}`, next);
    } catch {
      /* lasts for this page */
    }
  };

  const facet = graph.facets.find((f) => f.key === mode) ?? null;
  const groupsOf = (node: GraphNode): string[] => (facet ? (node.facets[facet.key] ?? []).slice(0, MAX_SLICES) : node.kind === 'missing' ? [] : [node.kind]);

  // Build the simulation datasets once per graph. d3 mutates these in place.
  const { nodes, links } = useMemo(() => {
    const nodes: Node[] = graph.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = graph.links
      .map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)! }))
      .filter((l) => l.source && l.target);
    return { nodes, links };
  }, [graph]);

  const hues = useMemo(() => huesOf(nodes.flatMap(groupsOf)), [nodes, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of nodes) for (const group of groupsOf(node)) map.set(group, (map.get(group) ?? 0) + 1);
    map.set('missing', nodes.filter((n) => n.kind === 'missing').length);
    map.set('none', nodes.filter((n) => n.kind !== 'missing' && groupsOf(n).length === 0).length);
    return map;
  }, [nodes, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  /** What the legend lists, in the wiki's own order: the folders, or the facet's values, then whatever else pages carry. */
  const legend = useMemo(() => {
    const named = facet ? facet.values.map((v) => ({ group: v.value, label: v.label })) : graph.kinds.map((k) => ({ group: k.kind, label: k.label }));
    const known = new Set(named.map((n) => n.group));
    const extra = [...hues.keys()].filter((group) => !known.has(group)).map((group) => ({ group, label: group }));
    return [...named, ...extra].filter(({ group }) => hues.has(group));
  }, [facet, graph.kinds, hues]);

  /** Where each group pulls its pages: evenly around the middle of the pane. */
  const anchors = useMemo(() => {
    if (!facet) return null;
    const groups = [...hues.keys()];
    const ring = Math.min(size.width, size.height) * 0.32;
    return new Map(
      groups.map((group, i) => {
        const angle = (i / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2;
        return [group, { x: size.width / 2 + Math.cos(angle) * ring, y: size.height / 2 + Math.sin(angle) * ring }];
      }),
    );
  }, [facet, hues, size]);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(320, Math.round(entry.contentRect.width)),
        height: Math.max(320, Math.round(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (nodes.length === 0) return;

    const pullOf = (node: Node): { x: number; y: number } | null => {
      if (!anchors) return null;
      const places = groupsOf(node).map((group) => anchors.get(group)).filter((p): p is { x: number; y: number } => !!p);
      if (places.length === 0) return null;
      return { x: places.reduce((s, p) => s + p.x, 0) / places.length, y: places.reduce((s, p) => s + p.y, 0) / places.length };
    };
    const shareGroup = (link: Link): boolean => {
      const a = groupsOf(link.source);
      return groupsOf(link.target).some((g) => a.includes(g));
    };

    const simulation = forceSimulation<Node>(nodes)
      .force(
        'link',
        forceLink<Node, Link>(links)
          .id((d) => d.id)
          .distance(110)
          .strength((link) => (anchors ? (shareGroup(link) ? 0.35 : 0.08) : 0.35)),
      )
      .force('charge', forceManyBody().strength(-420))
      .force('center', forceCenter(size.width / 2, size.height / 2))
      .force('collide', forceCollide<Node>().radius((d) => radius(d) + 14))
      .force('x', anchors ? forceX<Node>((d) => pullOf(d)?.x ?? size.width / 2).strength((d) => (pullOf(d) ? 0.12 : 0)) : null)
      .force('y', anchors ? forceY<Node>((d) => pullOf(d)?.y ?? size.height / 2).strength((d) => (pullOf(d) ? 0.12 : 0)) : null)
      .alphaDecay(0.045);

    // Re-render on every tick. React state is the frame driver here rather than
    // direct DOM mutation, which keeps the markup declarative at this scale.
    simulation.on('tick', () => setTick((t) => t + 1));
    simRef.current = simulation;

    return () => {
      simulation.stop();
      simRef.current = null;
    };
  }, [nodes, links, size.width, size.height, anchors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape clears the narrowing, as it does in the desktop app.
  useEffect(() => {
    if (!focus) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);

  function onPointerDown(event: React.PointerEvent, node: Node) {
    (event.target as Element).setPointerCapture(event.pointerId);
    setDragging(node.id);
    simRef.current?.alphaTarget(0.25).restart();
    node.fx = node.x;
    node.fy = node.y;
  }

  function onPointerMove(event: React.PointerEvent, node: Node) {
    if (dragging !== node.id) return;
    const rect = (event.currentTarget as SVGElement).ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    node.fx = ((event.clientX - rect.left) / rect.width) * size.width;
    node.fy = ((event.clientY - rect.top) / rect.height) * size.height;
  }

  function onPointerUp(node: Node) {
    if (dragging !== node.id) return;
    setDragging(null);
    simRef.current?.alphaTarget(0);
    node.fx = null;
    node.fy = null;
  }

  const neighbours = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const link of links) {
      if (link.source.id === hovered) set.add(link.target.id);
      if (link.target.id === hovered) set.add(link.source.id);
    }
    return set;
  }, [hovered, links]);

  // Past a certain size every label is noise. Then only the hubs keep theirs,
  // and whatever is under the pointer with its neighbours.
  const labelled = useMemo(() => {
    if (nodes.length <= LABEL_ALL_UP_TO) return null;
    return new Set(
      [...nodes]
        .sort((a, b) => b.degree - a.degree)
        .slice(0, LABELLED_HUBS)
        .map((n) => n.id),
    );
  }, [nodes]);
  const showsLabel = (node: Node): boolean =>
    labelled === null || labelled.has(node.id) || (neighbours?.has(node.id) ?? false);

  /** Whether a page is in the group the legend narrowed the graph to. */
  const inFocus = (node: Node): boolean => !focus || groupsOf(node).includes(focus);
  const dimmed = (node: Node): boolean => (neighbours ? !neighbours.has(node.id) : !inFocus(node));

  const written = graph.nodes.filter((n) => n.kind !== 'missing').length;

  return (
    <div className="graph-pane">
      <div className="graph-header">
        <span className="sidebar-title">Graph</span>
        <span className="muted small">
          {written} {written === 1 ? 'page' : 'pages'} · {graph.links.length} {graph.links.length === 1 ? 'link' : 'links'}
          {graph.orphans.length > 0 && ` · ${graph.orphans.length} not linked from anywhere`}
        </span>
        <span className="statusbar-spacer" />
        {graph.facets.length > 0 && (
          <>
            <button type="button" className={`graph-toggle${mode === FOLDERS ? ' active' : ''}`} onClick={() => chooseMode(FOLDERS)} title="Colour the pages by folder">
              Folders
            </button>
            {graph.facets.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`graph-toggle${mode === f.key ? ' active' : ''}`}
                onClick={() => chooseMode(f.key)}
                title={`Group the pages by ${f.label.toLowerCase()}`}
              >
                {f.label}
              </button>
            ))}
          </>
        )}
        <button
          type="button"
          className="graph-toggle"
          title="Lay the graph out again"
          onClick={() => simRef.current?.alpha(1).restart()}
        >
          <RotateCcw size={14} />
          <span>Re-lay out</span>
        </button>
      </div>

      <div className="graph-body">
        <div ref={hostRef} className="graph-host">
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={`${written} pages and ${graph.links.length} links in ${cluster}`}
          >
            <g>
              {links.map((link, i) => {
                const lit = neighbours ? neighbours.has(link.source.id) && neighbours.has(link.target.id) : false;
                const faded = neighbours ? !lit : focus ? !(inFocus(link.source) && inFocus(link.target)) : false;
                const broken = link.source.kind === 'missing' || link.target.kind === 'missing';
                return (
                  <line
                    key={i}
                    x1={link.source.x ?? 0}
                    y1={link.source.y ?? 0}
                    x2={link.target.x ?? 0}
                    y2={link.target.y ?? 0}
                    stroke={lit ? 'var(--accent)' : 'var(--text-faint)'}
                    strokeOpacity={lit ? 0.9 : faded ? 0.08 : 0.45}
                    strokeWidth={1}
                    strokeDasharray={broken ? '3 3' : undefined}
                  />
                );
              })}
            </g>

            <g>
              {nodes.map((node) => {
                const r = radius(node);
                const missing = node.kind === 'missing';
                const groups = groupsOf(node);
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                    opacity={dimmed(node) ? 0.18 : 1}
                    style={{ cursor: node.href ? 'pointer' : 'default' }}
                    onPointerDown={(e) => onPointerDown(e, node)}
                    onPointerMove={(e) => onPointerMove(e, node)}
                    onPointerUp={() => onPointerUp(node)}
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => node.href && !dragging && router.push(node.href)}
                  >
                    {groups.length > 1 ? (
                      groups.map((group, i) => (
                        <path key={group} d={slice(r, i, groups.length)} fill={colourOf(hues.get(group))} />
                      ))
                    ) : (
                      <circle r={r} fill={colourOf(hues.get(groups[0]))} fillOpacity={missing ? 0.55 : 1} />
                    )}
                    <circle r={r} fill="none" stroke={hovered === node.id ? 'var(--accent)' : 'none'} strokeWidth={2} />
                    {showsLabel(node) && (
                      <text
                        y={r + 14}
                        textAnchor="middle"
                        fontSize={11}
                        style={{
                          pointerEvents: 'none',
                          fill: hovered === node.id ? 'var(--text-normal)' : 'var(--text-muted)',
                          paintOrder: 'stroke',
                          stroke: 'var(--bg-primary)',
                          strokeWidth: 3,
                        }}
                      >
                        {node.label.length > 22 ? node.label.slice(0, 21) + '…' : node.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          <div className="graph-legend">
            {legend.map(({ group, label }) => (
              <div
                key={group}
                className={`graph-legend-row${facet ? ' clickable' : ''}${focus === group ? ' focused' : ''}`}
                title={facet ? (focus === group ? 'Show every page again' : `Show only the pages of ${label}`) : undefined}
                onClick={facet ? () => setFocus(focus === group ? null : group) : undefined}
              >
                <span className="graph-legend-swatch" style={{ background: colourOf(hues.get(group)) }} />
                <span>{label}</span>
                <span className="graph-legend-count">{counts.get(group) ?? 0}</span>
              </div>
            ))}
            {(counts.get('missing') ?? 0) > 0 && (
              <div className="graph-legend-row" title="Links to pages that do not exist yet">
                <span className="graph-legend-swatch unresolved" />
                <span>Not written yet</span>
                <span className="graph-legend-count">{counts.get('missing')}</span>
              </div>
            )}
            {facet && (counts.get('none') ?? 0) > 0 && (
              <div className="graph-legend-row" title={`Pages whose block gives no ${facet.label.toLowerCase()}`}>
                <span className="graph-legend-swatch" style={{ background: colourOf(undefined) }} />
                <span>Without a {facet.label.toLowerCase()}</span>
                <span className="graph-legend-count">{counts.get('none')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Well-connected pages read as the hubs they are. */
function radius(node: GraphNode): number {
  return 5 + Math.min(11, Math.sqrt(node.degree) * 3);
}

/** The i-th of n slices of a circle of radius r, starting at the top and going clockwise. */
function slice(r: number, i: number, n: number): string {
  const from = (i / n) * Math.PI * 2;
  const to = ((i + 1) / n) * Math.PI * 2;
  const x0 = (r * Math.sin(from)).toFixed(2);
  const y0 = (-r * Math.cos(from)).toFixed(2);
  const x1 = (r * Math.sin(to)).toFixed(2);
  const y1 = (-r * Math.cos(to)).toFixed(2);
  const large = to - from > Math.PI ? 1 : 0;
  return `M0,0 L${x0},${y0} A${r},${r} 0 ${large},1 ${x1},${y1} Z`;
}
