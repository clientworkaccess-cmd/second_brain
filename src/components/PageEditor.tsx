'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { EditorState, type StateCommand } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Bold, Check, Code, Heading, Italic, Link as LinkIcon, List, ListChecks, PenLine, Quote, Strikethrough } from 'lucide-react';
import { baseExtensions, livePreviewCompartment, livePreviewExtension } from '@/editor/extensions';
import { cycleHeading, insertLink, toggleBold, toggleBulletList, toggleInlineCode, toggleItalic, toggleQuote, toggleStrikethrough, toggleTaskList } from '@/editor/format';
import { MOD } from '@/editor/links';
import { targetsOf } from '@/editor/wikilinkCompletion';
import { pageHref, resolveLink } from '@/lib/wikilinks';

/**
 * A page in the desktop app's editor, in the browser.
 *
 * What is typed is saved on its own, a moment after the typing stops, and
 * again when the page is left. A save carries the version that was read; a
 * page that changed on disk since is not overwritten: the writer is told and
 * chooses. "Done" saves, makes a restore point, and goes back to reading.
 */

const SAVE_AFTER_MS = 800;

const BUTTONS: { icon: typeof Bold; title: string; command: StateCommand }[] = [
  { icon: Bold, title: `Bold (${MOD}+B)`, command: toggleBold },
  { icon: Italic, title: `Italic (${MOD}+I)`, command: toggleItalic },
  { icon: Strikethrough, title: 'Strikethrough', command: toggleStrikethrough },
  { icon: Code, title: 'Inline code', command: toggleInlineCode },
  { icon: Heading, title: 'Heading (cycles levels)', command: cycleHeading },
  { icon: List, title: 'Bullet list', command: toggleBulletList },
  { icon: ListChecks, title: 'Task list', command: toggleTaskList },
  { icon: Quote, title: 'Quote', command: toggleQuote },
  { icon: LinkIcon, title: `Link (${MOD}+K)`, command: insertLink },
];

type Status = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'failed';

export function PageEditor({
  cluster,
  slug,
  text,
  version,
  isNew,
  links,
  known,
}: {
  cluster: string;
  slug: string;
  text: string;
  version: string;
  /** The page does not exist yet: the text is a template, and the first save creates it. */
  isNew: boolean;
  /** What `[[` offers: how a link to each page is written, with the page's title. */
  links: { link: string; title: string }[];
  /** What every page is known by -> its slug, for following a link. */
  known: [string, string][];
}) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const versionRef = useRef(version);
  const dirtyRef = useRef(isNew);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>(isNew ? 'unsaved' : 'saved');
  const [conflict, setConflict] = useState<{ version: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const save = useCallback(
    async (options: { commit?: boolean; force?: boolean } = {}): Promise<boolean> => {
      const view = viewRef.current;
      if (!view) return false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!dirtyRef.current && !options.commit) return true;
      setStatus('saving');
      try {
        const res = await fetch('/api/page', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cluster, slug, text: view.state.doc.toString(), version: versionRef.current, force: options.force === true, commit: options.commit === true }),
        });
        const data = await res.json();
        if (res.status === 409) {
          setConflict({ version: String(data.version), text: String(data.text) });
          setStatus('conflict');
          return false;
        }
        if (!res.ok) throw new Error(data.error ?? 'That did not save');
        versionRef.current = String(data.version);
        dirtyRef.current = false;
        setConflict(null);
        setError(null);
        setStatus('saved');
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not save');
        setStatus('failed');
        return false;
      }
    },
    [cluster, slug],
  );

  // The editor itself. Made once; the document lives in it, not in React.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const knownMap = new Map(known);
    let stored = true;
    try {
      stored = localStorage.getItem('sb-editor-mode') !== 'source';
    } catch {
      /* live, then */
    }
    setLive(stored);

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          ...baseExtensions(
            {
              onSave: () => void save(),
              onOpenLink: (target) => {
                const found = resolveLink(knownMap, target);
                if (found) router.push(pageHref(cluster, found));
              },
              resolveImage: () => null,
              targets: targetsOf(links),
            },
            stored,
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            dirtyRef.current = true;
            setStatus((was) => (was === 'conflict' ? was : 'unsaved'));
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => void save(), SAVE_AFTER_MS);
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();

    const warn = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (timerRef.current) clearTimeout(timerRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // The page is opened once; a different page is a different editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, slug]);

  function toggleLive() {
    const next = !live;
    setLive(next);
    try {
      localStorage.setItem('sb-editor-mode', next ? 'live' : 'source');
    } catch {
      /* this page only */
    }
    viewRef.current?.dispatch({ effects: livePreviewCompartment.reconfigure(livePreviewExtension(next)) });
  }

  function run(command: StateCommand) {
    const view = viewRef.current;
    if (!view) return;
    command({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    view.focus();
  }

  async function done() {
    if (await save({ commit: true })) {
      router.push(pageHref(cluster, slug));
      router.refresh();
    }
  }

  function keepMine() {
    void save({ force: true });
  }

  function takeTheirs() {
    const view = viewRef.current;
    if (!view || !conflict) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: conflict.text } });
    versionRef.current = conflict.version;
    dirtyRef.current = false;
    setConflict(null);
    setStatus('saved');
  }

  const said: Record<Status, string> = {
    saved: 'Saved',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Not saved',
    failed: error ?? 'Not saved',
  };

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {BUTTONS.map(({ icon: Icon, title, command }) => (
          <button key={title} type="button" className="icon-button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => run(command)}>
            <Icon size={15} />
          </button>
        ))}
        <button
          type="button"
          className={`icon-button mode-toggle${live ? '' : ' active'}`}
          title={live ? 'Live preview on — switch to source mode' : 'Source mode — switch to live preview'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleLive}
        >
          {live ? <PenLine size={15} /> : <Code size={15} />}
          <span className="mode-label">{live ? 'Live' : 'Source'}</span>
        </button>
        <span className="statusbar-spacer" />
        <span className={`editor-status${status === 'failed' || status === 'conflict' ? ' is-problem' : ''}`} aria-live="polite">
          {said[status]}
        </span>
        <button type="button" className="icon-button mode-toggle done" title="Save and go back to reading" onClick={() => void done()}>
          <Check size={15} />
          <span className="mode-label">Done</span>
        </button>
      </div>

      {conflict && (
        <div className="external-banner" role="alert">
          <span>This page changed on disk since you opened it. Keep what you wrote, or take what is there now.</span>
          <button type="button" className="graph-toggle" onClick={keepMine}>
            Keep mine
          </button>
          <button type="button" className="graph-toggle" onClick={takeTheirs}>
            Take theirs
          </button>
          <Link className="graph-toggle" href={pageHref(cluster, slug)}>
            Read it
          </Link>
        </div>
      )}

      <div ref={hostRef} className="editor-host" />
    </div>
  );
}
