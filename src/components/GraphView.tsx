'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Maximize2 } from 'lucide-react';
import type { Graph } from '@/lib/graph';
import { UNRESOLVED_GROUP, areaHues, areaStats, groupHues, type GraphData } from '@/graph/data';
import { WebGLGraph, type GraphPalette } from '@/graph/webglGraph';

/**
 * The wiki as a graph: every page a node, every [[wikilink]] an edge.
 *
 * Drawn by the desktop app's WebGL engine (src/graph/webglGraph.ts, that
 * app's file as it is): links are one draw call and nodes another, so a wiki
 * of thousands of links draws at full speed; labels are drawn for the hovered
 * neighbourhood and, zoomed in, for everything. The pages are grouped by
 * folder, or by a facet the wiki has: then a page with several values is a
 * pie, each value gathers its pages around a place of its own, a soft disc is
 * drawn behind each, and a row of the legend highlights one and dims the rest.
 *
 * The layout and the data are separate (lib/graph.ts); this file turns the
 * one into what the engine takes, and owns the header and the legend.
 */

const FOLDERS = 'folders';

/** Hue -> the CSS colour the engine's shader uses, so the legend matches the dots. */
const colourOf = (hue: number | undefined, dark: boolean): string =>
  hue === undefined ? 'var(--text-faint)' : `hsl(${Math.round(hue)}, 62%, ${dark ? 64 : 42}%)`;

function readPalette(host: HTMLElement): GraphPalette {
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
function toData(graph: Graph, facet: string | null): GraphData {
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

export function GraphView({ graph, cluster }: { graph: Graph; cluster: string }) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WebGLGraph | null>(null);
  const hrefs = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.href])), [graph]);
  const hrefsRef = useRef(hrefs);
  hrefsRef.current = hrefs;

  const [mode, setMode] = useState<string>(FOLDERS);
  const [focus, setFocus] = useState<string | null>(null);
  const [dark, setDark] = useState(false);

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
  const data = useMemo(() => toData(graph, facet?.key ?? null), [graph, facet]);
  const folderHues = useMemo(() => groupHues(data.nodes.map((n) => n.group)), [data]);
  const valueHues = useMemo(() => areaHues(data.nodes.flatMap((n) => n.areas)), [data]);
  const stats = useMemo(() => areaStats(data.nodes), [data]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of data.nodes) map.set(node.group, (map.get(node.group) ?? 0) + 1);
    return map;
  }, [data]);

  // The engine, made once. It reads the theme from the page and follows it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new WebGLGraph(host, readPalette(host), {
      onNodeClick: (id) => {
        const href = hrefsRef.current.get(id);
        if (href) router.push(href);
      },
    });
    engineRef.current = engine;
    const follow = (): void => {
      const palette = readPalette(host);
      setDark(palette.dark);
      engine.setPalette(palette);
    };
    follow();
    const theme = new MutationObserver(follow);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    system.addEventListener('change', follow);
    return () => {
      theme.disconnect();
      system.removeEventListener('change', follow);
      engine.destroy();
      engineRef.current = null;
    };
    // The router is stable; the engine outlives renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mode first, so a fresh engine lays its first data set out in the right mode straight away.
  useEffect(() => {
    engineRef.current?.setAreaMode(facet !== null);
  }, [facet]);
  useEffect(() => {
    engineRef.current?.setData(data);
  }, [data]);
  useEffect(() => {
    engineRef.current?.setGroupHues(folderHues);
  }, [folderHues]);
  useEffect(() => {
    engineRef.current?.setAreaHues(valueHues);
  }, [valueHues]);
  useEffect(() => {
    engineRef.current?.setFocusArea(focus);
  }, [focus]);

  // Escape clears the narrowing, as it does in the desktop app.
  useEffect(() => {
    if (!focus) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);

  const written = graph.nodes.filter((n) => n.kind !== 'missing').length;
  const missing = graph.nodes.length - written;

  /** The legend's rows: the folders, or the facet's values in the wiki's own order, then whatever else pages carry. */
  const legend = facet
    ? (() => {
        const named = facet.values.map((v) => ({ key: v.value, label: v.label }));
        const known = new Set(named.map((n) => n.key));
        const extra = [...valueHues.keys()].filter((k) => !known.has(k)).map((k) => ({ key: k, label: k }));
        return [...named, ...extra].filter(({ key }) => valueHues.has(key)).map(({ key, label }) => ({ key, label, hue: valueHues.get(key), count: stats.counts.get(key) ?? 0 }));
      })()
    : graph.kinds.filter(({ kind }) => kind !== 'missing').map(({ kind, label }) => ({ key: kind, label, hue: folderHues.get(kind), count: counts.get(kind) ?? 0 }));

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
                title={`Group the pages by ${f.label.toLowerCase()}. A row of the legend highlights one.`}
              >
                {f.label}
              </button>
            ))}
          </>
        )}
        <button type="button" className="graph-toggle" title="Fit the whole graph in the pane" onClick={() => engineRef.current?.zoomToFit()}>
          <Maximize2 size={14} />
          <span>Fit</span>
        </button>
      </div>

      <div className="graph-body">
        <div ref={hostRef} className="graph-host" role="img" aria-label={`${written} pages and ${graph.links.length} links in ${cluster}`} />

        <div className={`graph-legend${facet ? ' interactive' : ''}`}>
          {legend.map(({ key, label, hue, count }) =>
            facet ? (
              <button
                key={key}
                type="button"
                className={`graph-legend-row${focus === key ? ' active' : ''}${focus !== null && focus !== key ? ' muted-row' : ''}`}
                aria-pressed={focus === key}
                title={focus === key ? 'Show every page again' : `Highlight ${label} and dim the rest`}
                onClick={() => setFocus(focus === key ? null : key)}
              >
                <span className="graph-legend-swatch" style={{ background: colourOf(hue, dark) }} />
                <span className="graph-legend-label">{label}</span>
                <span className="graph-legend-count">{count}</span>
              </button>
            ) : (
              <div key={key} className="graph-legend-row">
                <span className="graph-legend-swatch" style={{ background: colourOf(hue, dark) }} />
                <span className="graph-legend-label">{label}</span>
                <span className="graph-legend-count">{count}</span>
              </div>
            ),
          )}
          {facet && stats.none > 0 && (
            <div className="graph-legend-row" title={`Pages whose block gives no ${facet.label.toLowerCase()}`}>
              <span className="graph-legend-swatch" style={{ background: 'var(--text-muted)', opacity: 0.45 }} />
              <span className="graph-legend-label">Without a {facet.label.toLowerCase()}</span>
              <span className="graph-legend-count">{stats.none}</span>
            </div>
          )}
          {missing > 0 && (
            <div className="graph-legend-row" title="Links to pages that do not exist yet">
              <span className="graph-legend-swatch unresolved" />
              <span className="graph-legend-label">Not written yet</span>
              <span className="graph-legend-count">{missing}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
