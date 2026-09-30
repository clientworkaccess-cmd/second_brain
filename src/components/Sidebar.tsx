'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ListChecks,
  MessageSquare,
  Waypoints, ShieldCheck } from 'lucide-react';
import type { Cluster } from '@/lib/clusters';
import type { Facet } from '@/lib/facets';
import type { SearchHit } from '@/lib/search';
import type { Listing, PageRef } from '@/lib/wiki';
import { pageHref } from '@/lib/wikilinks';
import { NewPageButton } from '@/components/NewPageButton';

/**
 * The left sidebar. In a cluster it is the page tree and the search, as in the
 * desktop app; on the front page it is the list of clusters.
 */

/** The index and the log are called what they are. Every other page goes by its title. */
const nameOf = (page: PageRef): string => (page.slug === 'index' ? 'Index' : page.slug === 'log' ? 'Log' : page.title);

/** A wiki with this many pages opens with its folders closed: the tree is for finding a folder first. */
const MANY_PAGES = 60;

/** One value per facet, or none. `{ business: 'harbour-bakery' }`. */
type Filters = Record<string, string>;

/** The filters, kept for as long as the browser tab is, per wiki. */
function rememberedFilters(cluster: string): Filters {
  try {
    return JSON.parse(sessionStorage.getItem(`sb-filter:${cluster}`) ?? '{}') as Filters;
  } catch {
    return {};
  }
}

function remember(cluster: string, filters: Filters): void {
  try {
    sessionStorage.setItem(`sb-filter:${cluster}`, JSON.stringify(filters));
  } catch {
    /* the filter lasts for this page */
  }
}

/** Whether a page carries every value the filters ask for. */
function passes(page: PageRef, filters: Filters): boolean {
  return Object.entries(filters).every(([key, value]) => !value || (page.facets[key] ?? []).includes(value));
}

export function PageSidebar({ cluster, listing }: { cluster: string; listing: Listing }) {
  const pathname = decodeURIComponent(usePathname());
  const [panel, setPanel] = useState<'pages' | 'search'>('pages');
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(listing.total > MANY_PAGES ? listing.folders.map((f) => f.dir) : []),
  );
  const home = `/c/${cluster}`;
  // The index is the front page of the wiki. It is listed first among the pages beside it.
  const beside = [...listing.root].sort((a, b) => Number(b.slug === 'index') - Number(a.slug === 'index'));

  // A link from a page's block arrives as ?business=harbour-bakery. That sets
  // the filter; the filter then stays until it is cleared, page after page.
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>({});
  useEffect(() => {
    const next = { ...rememberedFilters(cluster) };
    let asked = false;
    for (const facet of listing.facets) {
      const value = params.get(facet.key);
      if (value === null) continue;
      next[facet.key] = value.toLowerCase();
      asked = true;
    }
    setFilters(next);
    if (asked) remember(cluster, next);
  }, [cluster, params, listing.facets]);
  const setFilter = (key: string, value: string): void => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    remember(cluster, next);
  };
  const filtering = Object.values(filters).some(Boolean);
  const folders = useMemo(
    () => (filtering ? listing.folders.map((folder) => ({ ...folder, pages: folder.pages.filter((page) => passes(page, filters)) })) : listing.folders),
    [listing.folders, filters, filtering],
  );

  const toggle = (dir: string): void =>
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  // Opening a page opens its folder, so the tree shows where the reader is.
  useEffect(() => {
    const here = listing.folders.find((folder) => folder.pages.some((page) => `${home}/${page.slug}` === pathname));
    if (!here) return;
    setCollapsed((was) => (was.has(here.dir) ? new Set([...was].filter((dir) => dir !== here.dir)) : was));
  }, [pathname, listing, home]);

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
            <NewPageButton cluster={cluster} folders={listing.folders.map(({ dir, label }) => ({ dir, label }))} />
            <button
              type="button"
              className="icon-button"
              title="Collapse all"
              onClick={() => setCollapsed(new Set(listing.folders.map((f) => f.dir)))}
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
        <Link className={`icon-button${pathname === `${home}/check` ? ' active' : ''}`} href={`${home}/check`} title="Check the wiki against its rules">
          <ListChecks size={16} />
        </Link>
        <Link className="icon-button" href="/" title="All clusters">
          <FolderOpen size={16} />
        </Link>
      </div>

      <div className="sidebar-body">
        {panel === 'search' ? (
          <SearchPanel cluster={cluster} listing={listing} filters={filters} />
        ) : (
          <nav className="tree" aria-label="Pages">
            {listing.facets.length > 0 && (
              <FacetFilters facets={listing.facets} filters={filters} onChange={setFilter} />
            )}
            {folders.map(({ dir, label, pages: refs }) => {
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
                      const href = pageHref(cluster, ref.slug);
                      return (
                        <Link
                          key={ref.slug}
                          href={href}
                          className={`tree-row file${pathname === `${home}/${ref.slug}` ? ' active' : ''}`}
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
            {beside.map((page) => {
              const at = page.slug === 'index' ? home : `${home}/${page.slug}`;
              return (
                <Link
                  key={page.slug}
                  href={page.slug === 'index' ? home : pageHref(cluster, page.slug)}
                  className={`tree-row file${pathname === at ? ' active' : ''}`}
                  title={page.title}
                >
                  <span className="tree-chevron" style={{ marginLeft: 4 }} />
                  <FileText className="tree-icon" size={15} />
                  <span className="tree-name">{nameOf(page)}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    </>
  );
}

/** One drop-down per facet. The first choice in each is no filter. */
function FacetFilters({ facets, filters, onChange }: { facets: Facet[]; filters: Filters; onChange: (key: string, value: string) => void }) {
  return (
    <div className="tree-filters">
      {facets.map((facet) => {
        const current = filters[facet.key] ?? '';
        return (
          <select
            key={facet.key}
            className={`tree-filter${current ? ' set' : ''}`}
            aria-label={`Show only pages with this ${facet.label.toLowerCase()}`}
            value={current}
            onChange={(e) => onChange(facet.key, e.target.value)}
          >
            <option value="">{`Every ${facet.label.toLowerCase()}`}</option>
            {facet.values.map((value) => (
              <option key={value.value} value={value.value}>
                {value.label}
              </option>
            ))}
            {current && !facet.values.some((value) => value.value === current) && <option value={current}>{current}</option>}
          </select>
        );
      })}
    </div>
  );
}

function SearchPanel({ cluster, listing, filters }: { cluster: string; listing: Listing; filters: Filters }) {
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

  // The tree's filters apply here too: a search inside one business finds pages of that business.
  const byslug = useMemo(() => new Map([...listing.folders.flatMap((f) => f.pages), ...listing.root].map((page) => [page.slug, page])), [listing]);
  const shown = useMemo(() => {
    if (!hits || !Object.values(filters).some(Boolean)) return hits;
    return hits.filter((hit) => {
      const page = byslug.get(hit.slug);
      return page ? passes(page, filters) : true;
    });
  }, [hits, filters, byslug]);

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
      {shown && !error && (
        <div className="search-summary muted small">
          {shown.length === 0 ? 'Nothing found' : `${shown.length} ${shown.length === 1 ? 'page' : 'pages'}`}
          {hits && shown.length !== hits.length && ` of ${hits.length}, with the filters`}
        </div>
      )}
      <div className="search-results">
        {(shown ?? []).map((hit) => (
          <Link key={hit.slug} href={pageHref(cluster, hit.slug)} className="search-hit">
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
        <Link className={`icon-button${pathname === '/security' ? ' active' : ''}`} href="/security" title="Security: who is signed in, and what was done">
          <ShieldCheck size={16} />
        </Link>
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
