'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { BookOpen, Users, Lightbulb, GitCompare, MessageSquareQuote, Menu, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PageDir, PageRef } from '@/lib/wiki';
import { cx } from '@/components/ui';

const SECTIONS: { dir: PageDir; label: string; icon: LucideIcon }[] = [
  { dir: 'entities', label: 'Entities', icon: Users },
  { dir: 'concepts', label: 'Concepts', icon: Lightbulb },
  { dir: 'comparisons', label: 'Comparisons', icon: GitCompare },
  { dir: 'queries', label: 'Saved answers', icon: MessageSquareQuote },
];

export function Sidebar({
  cluster,
  pages,
}: {
  cluster: string;
  pages: Record<PageDir, PageRef[]>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="space-y-6">
      <SidebarLink
        href={`/c/${cluster}`}
        icon={BookOpen}
        label="Index"
        active={pathname === `/c/${cluster}`}
        onNavigate={() => setOpen(false)}
      />

      {SECTIONS.map(({ dir, label, icon: Icon }) => {
        const refs = pages[dir] ?? [];
        if (refs.length === 0) return null;
        return (
          <div key={dir}>
            <h3 className="mb-2 flex items-center gap-2 px-3 text-caption font-medium uppercase tracking-[0.1em] text-muted">
              <Icon className="h-3.5 w-3.5 text-lavender" strokeWidth={1.75} />
              {label}
            </h3>
            <ul className="space-y-0.5">
              {refs.map((ref) => (
                <li key={ref.slug}>
                  <SidebarLink
                    href={`/c/${cluster}/${ref.slug}`}
                    label={ref.title}
                    active={pathname === `/c/${cluster}/${ref.slug}`}
                    onNavigate={() => setOpen(false)}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile trigger — internal luminescence matching the topbar */}
      <button
        onClick={() => setOpen(true)}
        className="glass fixed bottom-5 left-5 z-overlay flex h-11 w-11 items-center justify-center rounded-lg border border-graphite text-bright shadow-subtle lg:hidden"
        aria-label="Open page list"
      >
        <Menu className="h-5 w-5" strokeWidth={1.75} />
      </button>

      {open && (
        <div className="fixed inset-0 z-overlay bg-abyss/85 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)}>
          <aside
            className="h-full w-[min(20rem,85vw)] overflow-y-auto border-r border-graphite bg-surface p-5 shadow-subtle"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="mb-6 flex h-9 w-9 items-center justify-center rounded-lg text-medium hover:text-bright"
              aria-label="Close page list"
            >
              <X className="h-5 w-5" strokeWidth={1.75} />
            </button>
            {nav}
          </aside>
        </div>
      )}

      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-28 max-h-[calc(100dvh-9rem)] overflow-y-auto pr-2">{nav}</div>
      </aside>
    </>
  );
}

function SidebarLink({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  icon?: LucideIcon;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cx(
        'flex items-center gap-2 rounded-lg px-3 py-1.5 text-body-sm transition-colors',
        active
          ? 'bg-tag-bg font-medium text-lavender shadow-[inset_2px_0_0_0_#7c3aed]'
          : 'text-medium hover:bg-white/[0.04] hover:text-bright',
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 text-lavender" strokeWidth={1.75} />}
      <span className="truncate">{label}</span>
    </Link>
  );
}

