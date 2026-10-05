'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Waypoints,
} from 'lucide-react';
import type { Cluster } from '@/lib/clusters';
import type { SearchHit } from '@/lib/search';
import type { PageDir, PageRef } from '@/lib/wiki';

/**
 * The left sidebar. In a cluster it is the page tree and the search, as in the
 * desktop app; on the front page it is the list of clusters.
 */

const FOLDERS: { dir: PageDir; label: string }[] = [
  { dir: 'entities', label: 'Entities' },
  { dir: 'concepts', label: 'Concepts' },
  { dir: 'comparisons', label: 'Comparisons' },
  { dir: 'queries', label: 'Saved answers' },
];

export function PageSidebar({ cluster, pages }: { cluster: string; pages: Record<PageDir, PageRef[]> }) {
  const pathname = usePathname();
  const [panel, setPanel] = useState<'pages' | 'search'>('pages');
  const [collapsed, setCollapsed] = useState<Set<PageDir>>(new Set());
  const home = `/c/${cluster}`;

  const toggle = (dir: PageDir): void =>
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  return (
    <>
      <div className="sidebar-header tabs">
        <button type="button" className={`panel-tab${panel === 'pages' ? ' active' : ''}`} onClick={() => setPanel('pages')}>
          Pages
        </button>
        <button type="button" className={`panel-tab${panel === 'search' ? ' active' : ''}`} onClick={() => setPanel('search')}>
          Search
        </button>
        <span className="statusbar-spacer" />
        {panel === 'pages' && (
          <>
            <Link className="icon-button" href={home} title="Add a document">
              <FilePlus size={16} />
            </Link>
            <button
              type="button"
              className="icon-button"
              title="Collapse all"
              onClick={() => setCollapsed(new Set(FOLDERS.map((f) => f.dir)))}
            >
              <ChevronsDownUp size={16} />
            </button>
          </>
        )}
        <Link className={`icon-button${pathname === `${home}/graph` ? ' active' : ''}`} href={`${home}/graph`} title="Graph view">
          <Waypoints size={16} />
        </Link>
        <Link className={`icon-button${pathname === `${home}/ask` ? ' active' : ''}`} href={`${home}/ask`} title="Ask a question">
          <MessageSquare size={16} />
        </Link>
        <Link className="icon-button" href="/" title="All clusters">
          <FolderOpen size={16} />
        </Link>
      </div>

      <div className="sidebar-body">
        {panel === 'search' ? (
          <SearchPanel cluster={cluster} />
        ) : (
          <nav className="tree" aria-label="Pages">
            {FOLDERS.map(({ dir, label }) => {
              const refs = pages[dir] ?? [];
              const open = !collapsed.has(dir);
              return (
                <div key={dir}>
                  <button type="button" className="tree-row" aria-expanded={open} onClick={() => toggle(dir)}>
                    <span className="tree-chevron" style={{ marginLeft: 4 }}>
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                    <Folder className="tree-icon" size={15} />
                    <span className="tree-name">{label}</span>
                    <span className="tree-count">{refs.length}</span>
                  </button>
                  {open &&
                    refs.map((ref) => {
                      const href = `${home}/${ref.slug}`;
                      return (
                        <Link
                          key={ref.slug}
                          href={href}
                          className={`tree-row file${pathname === href ? ' active' : ''}`}
                          title={ref.title}
                        >
                          <span className="tree-chevron" style={{ marginLeft: 20 }} />
                          <FileText className="tree-icon" size={15} />
                          <span className="tree-name">{ref.title}</span>
                        </Link>
                      );
                    })}
                </div>
              );
            })}
            <Link href={home} className={`tree-row file${pathname === home ? ' active' : ''}`}>
              <span className="tree-chevron" style={{ marginLeft: 4 }} />
              <FileText className="tree-icon" size={15} />
              <span className="tree-name">Index</span>
            </Link>
          </nav>
        )}
      </div>
    </>
  );
}

function SearchPanel({ cluster }: { cluster: string }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits(null);
      setError(null);
      return;
    }
    // Typing fires a request per pause, and answers can come back out of order.
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?cluster=${encodeURIComponent(cluster)}&q=${encodeURIComponent(text)}`);
        const data = await res.json();
        if (id !== latest.current) return;
        if (!res.ok) throw new Error(data.error ?? 'Search failed');
        setHits(data.hits as SearchHit[]);
        setError(null);
      } catch (err) {
        if (id !== latest.current) return;
        setError(err instanceof Error ? err.message : 'Search failed');
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [cluster, query]);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  return (
    <div className="search-panel">
      <div className="search-box">
        <input
          className="search-input"
          autoFocus
          value={query}
          placeholder="Search the pages"
          spellCheck={false}
          aria-label="Search the pages of this cluster"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <div className="search-summary small" style={{ color: 'var(--danger)' }}>{error}</div>}
      {hits && !error && (
        <div className="search-summary muted small">
          {hits.length === 0 ? 'Nothing found' : `${hits.length} ${hits.length === 1 ? 'page' : 'pages'}`}
        </div>
      )}
      <div className="search-results">
        {(hits ?? []).map((hit) => (
          <Link key={hit.slug} href={`/c/${cluster}/${hit.slug}`} className="search-hit">
            <span className="search-hit-title">
              <Highlighted text={hit.title} terms={terms} />
            </span>
            <span className="search-hit-snippet">
              <Highlighted text={hit.snippet} terms={terms} />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** The text with every occurrence of a search word marked. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  while (at < text.length) {
    let next = -1;
    let length = 0;
    for (const term of terms) {
      const found = lower.indexOf(term, at);
      if (found !== -1 && (next === -1 || found < next)) {
        next = found;
        length = term.length;
      }
    }
    if (next === -1) break;
    if (next > at) parts.push({ text: text.slice(at, next), hit: false });
    parts.push({ text: text.slice(next, next + length), hit: true });
    at = next + length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return <>{parts.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}</>;
}

export function ClusterSidebar({ clusters }: { clusters: Cluster[] }) {
  const pathname = usePathname();
  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">Clusters</span>
        <Link className={`icon-button${pathname === '/new' ? ' active' : ''}`} href="/new" title="New cluster">
          <FolderPlus size={16} />
        </Link>
      </div>
      <div className="sidebar-body">
        {clusters.length === 0 ? (
          <div className="muted pad">No clusters yet.</div>
        ) : (
          <nav className="tree" aria-label="Clusters">
            {clusters.map((cluster) => (
              <Link key={cluster.name} href={`/c/${cluster.name}`} className="tree-row" title={cluster.scope}>
                <span className="tree-chevron" style={{ marginLeft: 4 }}>
                  <ChevronRight size={14} />
                </span>
                <Folder className="tree-icon" size={15} />
                <span className="tree-name">{cluster.title}</span>
                <span className="tree-count">{cluster.pageCount}</span>
              </Link>
            ))}
          </nav>
        )}
      </div>
    </>
  );
}
