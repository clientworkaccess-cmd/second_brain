'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, MessageSquarePlus, PenLine, Pencil, X } from 'lucide-react';
import { CONVERSATIONS_CHANGED } from '@/components/conversationEvents';

/**
 * The conversations with this wiki, newest first: the sidebar's Chats tab.
 * One opens it; the pencil renames it; the cross deletes it (asked first).
 * A conversation that changed pages, and was not undone, carries a mark.
 */

interface Summary {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
  wrote: boolean;
  mode: 'discuss' | 'work';
}

function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function ChatsPanel({ cluster, pathname }: { cluster: string; pathname: string }) {
  const router = useRouter();
  const [list, setList] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const home = `/c/${cluster}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations?cluster=${encodeURIComponent(cluster)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'The conversations could not be read');
      setList(data.conversations as Summary[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The conversations could not be read');
    }
  }, [cluster]);

  useEffect(() => {
    void load();
    const again = (): void => void load();
    window.addEventListener(CONVERSATIONS_CHANGED, again);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED, again);
  }, [load, pathname]);

  async function rename(id: string) {
    const title = draft.trim();
    setRenaming(null);
    if (!title) return;
    const res = await fetch('/api/conversations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cluster, id, title }) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'That name could not be kept');
    await load();
    router.refresh();
  }

  async function remove(item: Summary) {
    if (!window.confirm(`Delete "${item.title}"? What was said in it goes. Pages it changed stay as they are.`)) return;
    const res = await fetch('/api/conversations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cluster, id: item.id }) });
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'That could not be deleted');
      return;
    }
    await load();
    if (pathname === `${home}/ask/${item.id}`) router.push(`${home}/ask`);
  }

  return (
    <nav className="tree" aria-label="Conversations">
      <Link href={`${home}/ask?new`} className="tree-row" title="Start a new conversation">
        <span className="tree-chevron" style={{ marginLeft: 4 }} />
        <MessageSquarePlus className="tree-icon" size={15} />
        <span className="tree-name">New conversation</span>
      </Link>
      {error && (
        <p role="alert" className="px-3 py-1 text-small text-danger">
          {error}
        </p>
      )}
      {list === null && !error && <p className="px-3 py-1 text-small text-muted">Loading…</p>}
      {list?.length === 0 && <p className="px-3 py-1 text-small text-muted">No conversations yet. Ask something to start one.</p>}
      {list?.map((item) => {
        const href = `${home}/ask/${item.id}`;
        const here = pathname === href;
        return renaming === item.id ? (
          <form
            key={item.id}
            className="tree-row chat-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void rename(item.id);
            }}
          >
            <input autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} onBlur={() => void rename(item.id)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} aria-label="The conversation's name" />
          </form>
        ) : (
          <div key={item.id} className={`tree-row file chat-row${here ? ' active' : ''}`}>
            <Link href={href} className="chat-row-link" title={`${item.title} · ${item.turns} ${item.turns === 1 ? 'question' : 'questions'}`}>
              <span className="tree-chevron" style={{ marginLeft: 4 }} />
              {item.wrote ? <PenLine className="tree-icon" size={15} /> : <MessageSquare className="tree-icon" size={15} />}
              <span className="tree-name">{item.title}</span>
              <span className="tree-count">{ago(item.updatedAt)}</span>
            </Link>
            <button
              type="button"
              className="chat-row-action"
              title="Rename"
              onClick={() => {
                setDraft(item.title);
                setRenaming(item.id);
              }}
            >
              <Pencil size={12} />
            </button>
            <button type="button" className="chat-row-action" title="Delete" onClick={() => void remove(item)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
