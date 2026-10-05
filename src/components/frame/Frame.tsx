import type { ReactNode } from 'react';
import { Scrim, SignOut, TabBar, ThemeToggle, type Tab } from './controls';

/**
 * The frame every signed-in page sits in, laid out like the desktop app: a
 * sidebar on the left, the page in the centre, a panel on the right where a
 * page has one, and a status bar along the bottom. The window does not scroll;
 * the panes do.
 *
 * A layout renders <Frame>, a page renders <Center> and, if it has one, a
 * <RightSidebar> beside it.
 */
export function Frame({
  sidebar,
  status,
  children,
}: {
  sidebar: ReactNode;
  /** What the status bar says on the left, for example the cluster and its size. */
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <div className="app-body">
        <aside className="sidebar left">{sidebar}</aside>
        {children}
        <Scrim />
      </div>
      <footer className="statusbar">
        {status}
        <span className="statusbar-spacer" />
        {/* A page fills this through <StatusItems>. */}
        <span id="statusbar-page" className="contents" />
        <ThemeToggle />
        <SignOut />
      </footer>
    </div>
  );
}

export function Center({
  scope,
  tab,
  home = '/',
  hasRight = false,
  scroll = true,
  children,
}: {
  scope?: string;
  tab: Tab;
  home?: string;
  hasRight?: boolean;
  /** False for a view that fills the pane and scrolls by itself: the graph, the chat. */
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="center">
      <TabBar scope={scope} current={tab} home={home} hasRight={hasRight} />
      {scroll ? <div className="center-scroll">{children}</div> : children}
    </div>
  );
}

export interface Panel {
  id: string;
  label: string;
  content: ReactNode;
}
