'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelLeft, PanelRight, X } from 'lucide-react';

/**
 * The parts of the frame that react to the reader.
 *
 * Which sidebars are open, and the theme, live as attributes on <html> and in
 * localStorage, not in React state. The script in layout.tsx puts them there
 * before the first paint, so a reader who closed a sidebar or chose the light
 * theme never sees the other state flash by while the page wakes up.
 */

const NARROW = '(max-width: 900px)';
const root = (): HTMLElement => document.documentElement;

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, blocked storage: the choice lasts for this page */
  }
}

/** Opens and closes a sidebar. On a narrow screen the sidebar lies over the page and is not remembered. */
export function SidebarToggle({ side }: { side: 'left' | 'right' }) {
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  return (
    <button
      type="button"
      className="icon-button"
      title={side === 'left' ? 'Pages' : 'Backlinks and outline'}
      aria-label={side === 'left' ? 'Show or hide the page list' : 'Show or hide the side panel'}
      onClick={() => {
        const data = root().dataset;
        if (window.matchMedia(NARROW).matches) {
          const key = side === 'left' ? 'leftOpen' : 'rightOpen';
          const other = side === 'left' ? 'rightOpen' : 'leftOpen';
          if (data[key] === '1') delete data[key];
          else data[key] = '1';
          delete data[other];
          return;
        }
        const next = data[side] === '0' ? '1' : '0';
        data[side] = next;
        remember(`sb-${side}`, next);
      }}
    >
      <Icon size={16} />
    </button>
  );
}

function closeOverlays(): void {
  delete root().dataset.leftOpen;
  delete root().dataset.rightOpen;
}

/** The dimmed page behind a sidebar on a narrow screen. Also closes the sidebar when the reader goes somewhere. */
export function Scrim() {
  const pathname = usePathname();
  useEffect(() => closeOverlays(), [pathname]);
  return <button type="button" className="sidebar-scrim" aria-label="Close the panel" onClick={closeOverlays} />;
}

type Theme = 'system' | 'light' | 'dark';
const THEMES: Theme[] = ['system', 'light', 'dark'];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = root().dataset.theme;
    setTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
  }, []);

  return (
    <button
      type="button"
      className="statusbar-item"
      title="Switch between the system theme, light and dark"
      onClick={() => {
        const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        if (next === 'system') delete root().dataset.theme;
        else root().dataset.theme = next;
        remember('sb-theme', next);
        setTheme(next);
      }}
    >
      theme: {theme}
    </button>
  );
}

export function SignOut() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  return (
    <button
      type="button"
      className="statusbar-item"
      disabled={leaving}
      onClick={async () => {
        setLeaving(true);
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } catch {
          /* the cookie is what matters, and the login page is where we go either way */
        }
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

/** Lets a page put its own facts into the status bar, which belongs to the layout above it. */
export function StatusItems({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.getElementById('statusbar-page')), []);
  return target ? createPortal(children, target) : null;
}

export interface Tab {
  href: string;
  title: string;
}

/**
 * The open pages of a cluster, as tabs.
 *
 * Kept per browser tab in sessionStorage, the way the desktop app keeps them
 * per vault. The first render shows the current page alone, which is all the
 * server knows; the rest arrive once the browser has been asked.
 */
export function TabBar({
  scope,
  current,
  home,
  hasRight,
}: {
  /** What the tabs belong to, normally the cluster. Without one the bar shows the current page only. */
  scope?: string;
  current: Tab;
  /** Where to go when the last tab is closed. */
  home: string;
  hasRight: boolean;
}) {
  const router = useRouter();
  const [tabs, setTabs] = useState<Tab[]>([current]);
  const key = scope ? `sb-tabs:${scope}` : null;

  useEffect(() => {
    if (!key) {
      setTabs([current]);
      return;
    }
    let stored: Tab[] = [];
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      if (Array.isArray(parsed)) {
        stored = parsed.filter(
          (t): t is Tab => typeof t?.href === 'string' && typeof t?.title === 'string' && t.href.startsWith('/'),
        );
      }
    } catch {
      /* unreadable: start again from the current page */
    }
    const next = stored.some((t) => t.href === current.href)
      ? stored.map((t) => (t.href === current.href ? current : t))
      : [...stored, current];
    save(key, next);
    setTabs(next);
  }, [key, current.href, current.title]); // eslint-disable-line react-hooks/exhaustive-deps

  function close(tab: Tab): void {
    const at = tabs.findIndex((t) => t.href === tab.href);
    const next = tabs.filter((t) => t.href !== tab.href);
    if (key) save(key, next);
    setTabs(next);
    if (tab.href === current.href) router.push((next[at] ?? next[at - 1])?.href ?? home);
  }

  return (
    <div className="tabbar">
      <div className="tabbar-tools">
        <SidebarToggle side="left" />
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.href}
          className={`tab${tab.href === current.href ? ' active' : ''}`}
          title={tab.title}
          onAuxClick={(e) => {
            // The middle button closes a tab, as it does everywhere else.
            if (e.button !== 1 || !key) return;
            e.preventDefault();
            close(tab);
          }}
        >
          <Link href={tab.href} className="tab-name" aria-current={tab.href === current.href ? 'page' : undefined}>
            {tab.title}
          </Link>
          {key && (
            <button
              type="button"
              className="tab-close"
              title="Close"
              aria-label={`Close ${tab.title}`}
              onClick={() => close(tab)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      <span className="statusbar-spacer" />
      {hasRight && (
        <div className="tabbar-tools">
          <SidebarToggle side="right" />
        </div>
      )}
    </div>
  );
}

function save(key: string, tabs: Tab[]): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(tabs.slice(-30)));
  } catch {
    /* no storage: the tabs last until the next page */
  }
}
