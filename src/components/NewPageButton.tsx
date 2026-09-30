'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FilePenLine } from 'lucide-react';
import { slugOfTitle } from '@/lib/wikilinks';

/**
 * A new page, by hand: a title and a folder, then the editor with a template
 * in it. The page is written on the first save.
 */
export function NewPageButton({ cluster, folders }: { cluster: string; folders: { dir: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(folders[0]?.dir ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const slug = slugOfTitle(title);

  function go() {
    if (!slug) return;
    setOpen(false);
    const at = folder ? `${folder}/${slug}` : slug;
    router.push(`/c/${cluster}/edit/${at.split('/').map(encodeURIComponent).join('/')}?title=${encodeURIComponent(title.trim())}`);
  }

  return (
    <span className="relative">
      <button type="button" className={`icon-button${open ? ' active' : ''}`} title="New page" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <FilePenLine size={16} />
      </button>
      {open && (
        <form
          className="new-page"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <label className="new-page-field">
            <span>Title</span>
            <input ref={inputRef} className="search-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Mark Chen" />
          </label>
          {folders.length > 0 && (
            <label className="new-page-field">
              <span>Folder</span>
              <select className="tree-filter" value={folder} onChange={(e) => setFolder(e.target.value)}>
                {folders.map((f) => (
                  <option key={f.dir} value={f.dir}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {slug && (
            <div className="new-page-slug">
              {folder ? `${folder}/` : ''}
              <span className="text-accent">{slug}</span>.md
            </div>
          )}
          <div className="new-page-actions">
            <button type="button" className="graph-toggle" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="graph-toggle active" disabled={!slug}>
              Open the editor
            </button>
          </div>
        </form>
      )}
    </span>
  );
}
