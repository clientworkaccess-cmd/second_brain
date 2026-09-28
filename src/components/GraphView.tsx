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
import { Maximize2, TriangleAlert } from 'lucide-react';
import type { Graph, GraphNode } from '@/lib/graph';
import { Button, Badge } from '@/components/ui';

/**
 * The cluster as a graph: every page a node, every [[wikilink]] an edge.
 *
 * Hand-drawn SVG over a d3-force simulation rather than a graph SDK. At the
 * scale a cluster actually reaches — tens to low hundreds of pages — SVG is
 * fast, styleable straight from the design tokens, and adds ~30kb. The layout
 * and the data are separate (see lib/graph.ts), so this component can be
 * replaced by a licensed SDK later without touching anything upstream.
 */

interface Node extends SimulationNodeDatum, GraphNode {}
interface Link {
  source: Node;
  target: Node;
}

const COLOURS: Record<GraphNode['kind'], string> = {
  entities: '#a78bfa', // lavender
  concepts: '#4ade80', // success green
  comparisons: '#bcbcbc', // medium gray
  queries: '#eeeeee', // bright gray
  missing: '#f87171', // error red — linked but never written
};

const LEGEND: { kind: GraphNode['kind']; label: string }[] = [
  { kind: 'entities', label: 'Entities' },
  { kind: 'concepts', label: 'Concepts' },
  { kind: 'comparisons', label: 'Comparisons' },
  { kind: 'queries', label: 'Saved answers' },
  { kind: 'missing', label: 'Linked, not written' },
];

export function GraphView({ graph, cluster }: { graph: Graph; cluster: string }) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<Node, undefined> | null>(null);

  const [size, setSize] = useState({ width: 900, height: 560 });
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

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(320, entry.contentRect.width),
        height: Math.max(420, Math.min(720, entry.contentRect.width * 0.62)),
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

  if (graph.nodes.length === 0) return null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        {LEGEND.map(({ kind, label }) => {
          if (!graph.nodes.some((n) => n.kind === kind)) return null;
          return (
            <span key={kind} className="flex items-center gap-2 text-small text-muted">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: COLOURS[kind] }}
                aria-hidden
              />
              {label}
            </span>
          );
        })}
        <Button
          variant="quiet"
          className="ml-auto"
          onClick={() => simRef.current?.alpha(1).restart()}
        >
          <Maximize2 className="h-4 w-4" strokeWidth={2} />
          Re-lay out
        </Button>
      </div>

      <div ref={wrapRef} className="overflow-hidden rounded-xl border border-graphite bg-surface shadow-subtle">
        <svg
          width="100%"
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="block touch-none select-none"
          role="img"
          aria-label={`${graph.nodes.length} pages and ${graph.links.length} connections in ${cluster}`}
        >
          <g>
            {links.map((link, i) => {
              const dim = neighbours && !(neighbours.has(link.source.id) && neighbours.has(link.target.id));
              const broken = link.source.kind === 'missing' || link.target.kind === 'missing';
              return (
                <line
                  key={i}
                  x1={link.source.x ?? 0}
                  y1={link.source.y ?? 0}
                  x2={link.target.x ?? 0}
                  y2={link.target.y ?? 0}
                  stroke={broken ? '#f87171' : '#ffffff'}
                  strokeOpacity={dim ? 0.05 : broken ? 0.4 : 0.16}
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
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                  opacity={dim ? 0.2 : 1}
                  className={node.href ? 'cursor-pointer' : 'cursor-not-allowed'}
                  onPointerDown={(e) => onPointerDown(e, node)}
                  onPointerMove={(e) => onPointerMove(e, node)}
                  onPointerUp={() => onPointerUp(node)}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => node.href && !dragging && router.push(node.href)}
                >
                  <circle
                    r={r}
                    fill={COLOURS[node.kind]}
                    fillOpacity={node.kind === 'missing' ? 0.15 : 0.9}
                    stroke={COLOURS[node.kind]}
                    strokeWidth={node.kind === 'missing' ? 1.5 : 0}
                    strokeDasharray={node.kind === 'missing' ? '3 2' : undefined}
                  />
                  <text
                    y={r + 14}
                    textAnchor="middle"
                    className="pointer-events-none fill-current text-[11px]"
                    style={{ fill: hovered === node.id ? '#ffffff' : '#bcbcbc' }}
                  >
                    {node.label.length > 22 ? node.label.slice(0, 21) + '…' : node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{graph.nodes.filter((n) => n.kind !== 'missing').length} pages</Badge>
        <Badge>{graph.links.length} connections</Badge>
        {graph.orphans.length > 0 && (
          <Badge tone="danger">
            <TriangleAlert className="h-3 w-3" strokeWidth={2} />
            {graph.orphans.length} not linked from anywhere
          </Badge>
        )}
      </div>

      {graph.orphans.length > 0 && (
        <p className="mt-3 max-w-prose text-small text-medium">
          A page nothing links to is usually a curation miss — the agent wrote it but never
          connected it to the rest of the wiki. Worth reading before the next ingest builds on it.
        </p>
      )}
    </div>
  );
}

/** Well-connected pages read as the hubs they are. */
function radius(node: GraphNode): number {
  return 6 + Math.min(12, Math.sqrt(node.degree) * 3.4);
}
