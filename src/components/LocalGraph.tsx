'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Maximize2 } from 'lucide-react';
import type { Graph } from '@/lib/graph';
import { localGraph } from '@/lib/localGraph';
import { groupHues } from '@/graph/data';
import { readPalette, toData } from '@/graph/palette';
import { WebGLGraph } from '@/graph/webglGraph';

/**
 * The page's own neighbourhood, beside it: the pages one or two links away,
 * drawn by the same engine as the whole graph, with this page marked. A node
 * opens its page. The reach is remembered.
 */

const REACH_KEY = 'sb-local-graph-reach';

export function LocalGraph({ graph, cluster, current }: { graph: Graph; cluster: string; current: string }) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WebGLGraph | null>(null);
  const [reach, setReach] = useState<1 | 2>(2);
  const hrefs = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.href])), [graph]);
  const hrefsRef = useRef(hrefs);
  hrefsRef.current = hrefs;

  useEffect(() => {
    try {
      if (localStorage.getItem(REACH_KEY) === '1') setReach(1);
    } catch {
      /* two links, then */
    }
  }, []);
  const chooseReach = (next: 1 | 2): void => {
    setReach(next);
    try {
      localStorage.setItem(REACH_KEY, String(next));
    } catch {
      /* lasts for this page */
    }
  };

  const shown = useMemo(() => (reach === 2 ? graph : localGraph(graph, current, 1)), [graph, current, reach]);
  const data = useMemo(() => toData(shown, null), [shown]);
  const hues = useMemo(() => groupHues(data.nodes.map((n) => n.group)), [data]);

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
    const follow = (): void => engine.setPalette(readPalette(host));
    const theme = new MutationObserver(follow);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    system.addEventListener('change', follow);
    // The panel may be hidden when the page opens; when it is shown, fit the graph to it.
    let fit: ReturnType<typeof setTimeout> | null = null;
    const sized = new ResizeObserver(() => {
      if (host.clientWidth === 0) return;
      if (fit) clearTimeout(fit);
      fit = setTimeout(() => engine.zoomToFit(24), 400);
    });
    sized.observe(host);
    return () => {
      theme.disconnect();
      system.removeEventListener('change', follow);
      sized.disconnect();
      if (fit) clearTimeout(fit);
      engine.destroy();
      engineRef.current = null;
    };
    // The router is stable; the engine outlives renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setGroupHues(hues);
    engine.setData(data);
    engine.setActive(current);
    // The layout settles over the first second; fit it twice.
    const soon = setTimeout(() => engine.zoomToFit(24), 500);
    const later = setTimeout(() => engine.zoomToFit(24), 1500);
    return () => {
      clearTimeout(soon);
      clearTimeout(later);
    };
  }, [data, hues, current]);

  const pages = shown.nodes.filter((n) => n.kind !== 'missing').length - 1;
  return (
    <div className="local-graph">
      <div className="local-graph-header">
        <span className="muted small">
          {pages < 0 ? 'not in the graph' : `${pages} ${pages === 1 ? 'page' : 'pages'} around this one`}
        </span>
        <span className="statusbar-spacer" />
        <button type="button" className={`graph-toggle${reach === 1 ? ' active' : ''}`} title="Pages this one links to or from" onClick={() => chooseReach(1)}>
          1
        </button>
        <button type="button" className={`graph-toggle${reach === 2 ? ' active' : ''}`} title="And the pages those link to" onClick={() => chooseReach(2)}>
          2
        </button>
        <Link className="icon-button" href={`/c/${cluster}/graph`} title="Open the whole graph">
          <Maximize2 size={14} />
        </Link>
      </div>
      <div ref={hostRef} className="graph-host local" role="img" aria-label={`The pages around ${current}`} />
    </div>
  );
}
