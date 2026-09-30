'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PencilLine, Trash2 } from 'lucide-react';
import { pageHref } from '@/lib/wikilinks';

/**
 * Rename and delete, from the status bar of a page. A rename is a new title;
 * the file name and every link to the page follow. A delete says first how
 * many pages link here. Both make a restore point.
 */
export function PageActions({ cluster, slug, title, backlinks }: { cluster: string; slug: string; title: string; backlinks: number }) {
  const router = useRouter();
  const [mode, setMode] = useState<'closed' | 'rename' | 'delete'>('closed');
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  useEffect(() => {
    if (mode === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('closed');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  async function call(input: RequestInfo, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(input, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'That did not work');
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const data = await call('/api/page/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cluster, slug, title: name }) });
    if (!data) return;
    setMode('closed');
    router.push(pageHref(cluster, String(data.to)));
    router.refresh();
  }

  async function remove() {
    const data = await call('/api/page', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cluster, slug }) });
    if (!data) return;
    setMode('closed');
    router.push(`/c/${cluster}`);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="statusbar-item"
        title="Rename this page: its file name and every link to it follow"
        onClick={() => {
          setName(title);
          setError(null);
          setMode(mode === 'rename' ? 'closed' : 'rename');
        }}
      >
        <PencilLine size={12} />
        Rename
      </button>
      <button
        type="button"
        className="statusbar-item"
        title="Delete this page"
        onClick={() => {
          setError(null);
          setMode(mode === 'delete' ? 'closed' : 'delete');
        }}
      >
        <Trash2 size={12} />
        Delete
      </button>

      {mode === 'rename' && (
        <form
          className="page-action"
          role="dialog"
          aria-label="Rename this page"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <label className="new-page-field">
            <span>New title</span>
            <input ref={inputRef} className="search-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <p className="page-action-note">The file name and every link to this page follow. A restore point is made.</p>
          {error && (
            <p role="alert" className="page-action-error">
              {error}
            </p>
          )}
          <div className="new-page-actions">
            <button type="button" className="graph-toggle" onClick={() => setMode('closed')}>
              Cancel
            </button>
            <button type="submit" className="graph-toggle active" disabled={busy || !name.trim() || name.trim() === title}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      )}

      {mode === 'delete' && (
        <div className="page-action" role="dialog" aria-label="Delete this page">
          <p className="page-action-note">
            <strong className="text-ink">Delete “{title}”?</strong>
            <br />
            {backlinks === 0 ? 'No other page links here.' : `${backlinks} ${backlinks === 1 ? 'page links' : 'pages link'} here; those links will lead nowhere.`} A restore point is made first, and its
            line is taken out of the index.
          </p>
          {error && (
            <p role="alert" className="page-action-error">
              {error}
            </p>
          )}
          <div className="new-page-actions">
            <button type="button" className="graph-toggle" onClick={() => setMode('closed')}>
              Cancel
            </button>
            <button type="button" className="graph-toggle danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
