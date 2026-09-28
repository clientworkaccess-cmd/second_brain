import Link from 'next/link';
import { Gem } from 'lucide-react';
import type { ReactNode } from 'react';
import { LogoutButton } from './LogoutButton';

/** Floating pill navbar with internal luminescence. Sticky layer of the z-index contract. */
export function TopBar({
  children,
  showLogout = true,
}: {
  children?: ReactNode;
  showLogout?: boolean;
}) {
  return (
    <header className="sticky top-0 z-sticky px-4 pt-4 sm:px-6">
      <div className="glass mx-auto flex max-w-shell items-center gap-4 rounded-xl px-4 py-3 shadow-subtle border border-graphite">
        <Link href="/" className="group flex items-center gap-2.5 text-bright transition-opacity hover:opacity-90">
          <div className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-amethyst/40 bg-surface shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)]">
            <Gem className="h-4 w-4 text-lavender transition-transform group-hover:scale-105" strokeWidth={2} />
          </div>
          <span className="font-semibold tracking-tight text-bright">
            Knowledge <span className="text-lavender">Graph</span>
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          {children}
          {showLogout && <LogoutButton />}
        </div>
      </div>
    </header>
  );
}

