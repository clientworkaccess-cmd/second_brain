'use client';

import { useEffect, useId, useState } from 'react';
import { Check, Copy, Maximize2, X } from 'lucide-react';
import { darkTheme, safeDiagram } from '@/lib/diagrams';

/**
 * A ```mermaid block in an answer, drawn as a picture.
 *
 * Mermaid is large, so it is loaded only when a diagram is on the screen. It
 * draws in strict mode: no scripts, no links, no click handlers, and the SVG
 * it returns is sanitised by it before it is put in the page. A diagram that
 * does not parse is shown as its code, with a line saying so; one that is
 * still arriving (`pending`) waits, so a half-written diagram never flickers.
 * It follows the app's light and dark theme.
 */

type Mermaid = (typeof import('mermaid'))['default'];
let loading: Promise<Mermaid> | null = null;
const loadMermaid = (): Promise<Mermaid> => (loading ??= import('mermaid').then((m) => m.default));

// One render at a time: mermaid keeps its configuration globally.
let queue: Promise<unknown> = Promise.resolve();

async function draw(id: string, code: string, dark: boolean): Promise<string> {
  const mermaid = await loadMermaid();
  const run = queue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'neutral',
      fontFamily: 'inherit',
      suppressErrorRendering: true,
    });
    try {
      return (await mermaid.render(id, code)).svg;
    } finally {
      // Mermaid leaves its scratch element behind when a diagram fails.
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

function useDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (): void => setDark(darkTheme(document.documentElement.getAttribute('data-theme'), system.matches));
    follow();
    const theme = new MutationObserver(follow);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    system.addEventListener('change', follow);
    return () => {
      theme.disconnect();
      system.removeEventListener('change', follow);
    };
  }, []);
  return dark;
}

export function MermaidDiagram({ code, pending = false }: { code: string; pending?: boolean }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const dark = useDark();
  const safe = safeDiagram(code);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (pending || !safe) return;
    let live = true;
    draw(id, safe, dark).then(
      (drawn) => live && (setSvg(drawn), setFailed(false)),
      () => live && (setSvg(null), setFailed(true)),
    );
    return () => {
      live = false;
    };
  }, [id, safe, dark, pending]);

  useEffect(() => {
    if (!full) return;
    const close = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [full]);

  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (!safe || failed) {
    return (
      <figure className="diagram diagram-failed" data-diagram="failed">
        <figcaption className="muted small">This diagram could not be drawn; here is what it says.</figcaption>
        <pre>
          <code>{code}</code>
        </pre>
      </figure>
    );
  }

  if (pending || !svg) {
    return (
      <figure className="diagram" data-diagram="pending" aria-busy="true">
        <span className="muted small">Drawing the diagram…</span>
      </figure>
    );
  }

  return (
    <>
      <figure className="diagram" data-diagram="drawn">
        <div className="diagram-tools">
          <button type="button" className="graph-toggle" onClick={copy} title="Copy what the diagram is written in">
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy code'}
          </button>
          <button type="button" className="graph-toggle" onClick={() => setFull(true)} title="Show the diagram on the whole screen">
            <Maximize2 size={13} />
            Enlarge
          </button>
        </div>
        <div className="diagram-picture" dangerouslySetInnerHTML={{ __html: svg }} />
      </figure>
      {full && (
        <div className="diagram-full" role="dialog" aria-modal="true" aria-label="Diagram" onClick={() => setFull(false)}>
          <button type="button" className="graph-toggle diagram-close" onClick={() => setFull(false)} title="Close (Esc)">
            <X size={14} />
            Close
          </button>
          <div className="diagram-picture" onClick={(e) => e.stopPropagation()} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      )}
    </>
  );
}
