'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { RotateCcw } from 'lucide-react';
import type { Graph, GraphNode } from '@/lib/graph';

/**
 * The cluster as a graph: every page a node, every [[wikilink]] an edge.
 *
 * Laid out and coloured like the desktop app's graph: a header above, the
 * graph filling the pane, the legend in its corner, one colour per folder. The
 * desktop draws with WebGL because a vault reaches thousands of links; a
 * cluster reaches tens to low hundreds of pages, where SVG is fast and needs no
 * more code than this. The layout and the data are separate (see lib/graph.ts),
 * so the renderer can be swapped without touching anything upstream.
 */

interface Node extends SimulationNodeDatum, GraphNode {}
interface Link {
  source: Node;
  target: Node;
}

/**
 * One hue per folder, spread by the golden angle over the folder names in
 * alphabetical order. This is the desktop app's rule (core/graph.ts there), so
 * the same wiki gets the same kind of colours in both.
 */
function folderHues(kinds: string[]): Map<string, number> {
  const sorted = [...new Set(kinds)].filter((k) => k !== 'missing').sort((a, b) => a.localeCompare(b));
  return new Map(sorted.map((kind, i) => [kind, (i * 137.508) % 360]));
}

/** Up to this many pages, every one is labelled. */
const LABEL_ALL_UP_TO = 120;
/** Past that, the pages with the most links keep their labels. */
const LABELLED_HUBS = 30;

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

  // Build the simulation datasets once per graph. d3 mutates these in place.
  const { nodes, links } = useMemo(() => {
    const nodes: Node[] = graph.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = graph.links
      .map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)! }))
      .filter((l) => l.source && l.target);
    return { nodes, links };
  }, [graph]);

  const hues = useMemo(() => folderHues(graph.nodes.map((n) => n.kind)), [graph]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of graph.nodes) map.set(node.kind, (map.get(node.kind) ?? 0) + 1);
    return map;
  }, [graph]);

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

    const simulation = forceSimulation<Node>(nodes)
      .force('link', forceLink<Node, Link>(links).id((d) => d.id).distance(110).strength(0.35))
      .force('charge', forceManyBody().strength(-420))
      .force('center', forceCenter(size.width / 2, size.height / 2))
      .force('collide', forceCollide<Node>().radius((d) => radius(d) + 14))
      .alphaDecay(0.045);

    // Re-render on every tick. React state is the frame driver here rather than
    // direct DOM mutation, which keeps the markup declarative at this scale.
    simulation.on('tick', () => setTick((t) => t + 1));
    simRef.current = simulation;

    return () => {
      simulation.stop();
      simRef.current = null;
    };
  }, [nodes, links, size.width, size.height]);

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
                const broken = link.source.kind === 'missing' || link.target.kind === 'missing';
                return (
                  <line
                    key={i}
                    x1={link.source.x ?? 0}
                    y1={link.source.y ?? 0}
                    x2={link.target.x ?? 0}
                    y2={link.target.y ?? 0}
                    stroke={lit ? 'var(--accent)' : 'var(--text-faint)'}
                    strokeOpacity={neighbours ? (lit ? 0.9 : 0.12) : 0.45}
                    strokeWidth={1}
                    strokeDasharray={broken ? '3 3' : undefined}
                  />
                );
              })}
            </g>

            <g>
              {nodes.map((node) => {
                const dim = neighbours && !neighbours.has(node.id);
                const r = radius(node);
                const missing = node.kind === 'missing';
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                    opacity={dim ? 0.2 : 1}
                    style={{ cursor: node.href ? 'pointer' : 'default' }}
                    onPointerDown={(e) => onPointerDown(e, node)}
                    onPointerMove={(e) => onPointerMove(e, node)}
                    onPointerUp={() => onPointerUp(node)}
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => node.href && !dragging && router.push(node.href)}
                  >
                    <circle
                      r={r}
                      fill={colourOf(hues.get(node.kind))}
                      fillOpacity={missing ? 0.55 : 1}
                      stroke={hovered === node.id ? 'var(--accent)' : 'none'}
                      strokeWidth={2}
                    />
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
            {graph.kinds
              .filter(({ kind }) => hues.has(kind))
              .map(({ kind, label }) => (
                <div key={kind} className="graph-legend-row">
                  <span className="graph-legend-swatch" style={{ background: colourOf(hues.get(kind)) }} />
                  <span>{label}</span>
                  <span className="graph-legend-count">{counts.get(kind) ?? 0}</span>
                </div>
              ))}
            {counts.has('missing') && (
              <div className="graph-legend-row" title="Links to pages that do not exist yet">
                <span className="graph-legend-swatch unresolved" />
                <span>Not written yet</span>
                <span className="graph-legend-count">{counts.get('missing')}</span>
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
