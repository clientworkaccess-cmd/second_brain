'use client';

import { useState } from 'react';
import type { Panel } from './Frame';

/**
 * The panel on the right: a few views of the page that is open, one at a time.
 *
 * Every view is rendered and the ones not chosen are hidden, so a view keeps
 * its scroll position while another is looked at.
 */
export function RightSidebar({ panels }: { panels: Panel[] }) {
  const [active, setActive] = useState(panels[0]?.id);
  const shown = panels.find((p) => p.id === active) ?? panels[0];
  if (!shown) return null;

  return (
    <aside className="sidebar right">
      <div className="sidebar-header tabs">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={`panel-tab${panel.id === shown.id ? ' active' : ''}`}
            onClick={() => setActive(panel.id)}
          >
            {panel.label}
          </button>
        ))}
      </div>
      {panels.map((panel) => (
        <div key={panel.id} className="sidebar-body" hidden={panel.id !== shown.id}>
          {panel.content}
        </div>
      ))}
    </aside>
  );
}
