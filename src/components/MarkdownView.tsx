import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { assetHref, resolveImagePath } from '@/lib/assetPaths';
import { remarkCallouts } from '@/lib/callouts';
import { linkifyWikilinks } from '@/lib/wikilinks';
import type { Heading } from '@/lib/outline';

/**
 * Renders a wiki page in the reading view, and an answer in the chat. It
 * imports nothing that needs the server, so both can use it.
 *
 * `[[wikilinks]]` are rewritten to real routes before the markdown parser sees
 * them. A link whose target does not exist on disk is rendered visibly dead
 * rather than silently 404ing — an orphan link is a curation signal worth
 * seeing, not hiding.
 *
 * `outline` gives the headings their ids, in the order they appear, so that the
 * outline panel and the page agree on where each heading is.
 */
export function MarkdownView({
  source,
  cluster,
  titles,
  outline,
  images,
  fromDir,
}: {
  source: string;
  cluster: string;
  titles: Map<string, string>;
  outline?: Heading[];
  /** The images the wiki has, as paths from its root. Without them, an image is shown as omitted. */
  images?: string[];
  /** The page's own folder, from the wiki's root, for images named by a relative path. */
  fromDir?: string;
}) {
  const imageFor = images
    ? (target: string): string | null => {
        const rel = resolveImagePath(images, target, fromDir ?? '');
        return rel ? assetHref(cluster, rel) : null;
      }
    : undefined;
  const linked = linkifyWikilinks(source, cluster, titles, imageFor);

  let seen = 0;
  const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
    function HeadingWithId({ children }: { children?: ReactNode }) {
      const id = outline?.[seen++]?.id;
      return <Tag id={id}>{children}</Tag>;
    };

  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkCallouts]}
      components={{
        h1: heading('h1'),
        h2: heading('h2'),
        h3: heading('h3'),
        h4: heading('h4'),
        h5: heading('h5'),
        h6: heading('h6'),
        a({ href, children }: ComponentProps<'a'>) {
          const target = href ?? '';

          if (target.includes('?missing=')) {
            return (
              <span className="is-unresolved" title="This page is linked but does not exist yet">
                {children}
              </span>
            );
          }

          if (target.startsWith('/')) return <Link href={target}>{children}</Link>;

          // Only ordinary web and mail addresses. A document can carry a link
          // that runs script when clicked, and this is where it would land.
          if (!/^(https?:|mailto:)/i.test(target)) return <span>{children}</span>;

          // External. Never let an ingested document open a tab with a live
          // opener reference back into the app.
          return (
            <a href={target} className="external-link" target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          );
        },
        img({ src, alt, title }: ComponentProps<'img'>) {
          const source = typeof src === 'string' ? src : '';
          // An image of the wiki, by its address or by a path a page wrote.
          // Anything remote is left out: a document can carry an address that
          // tells its owner who opened it.
          const href = source.startsWith('/api/asset?') ? source : !/^[a-z][a-z0-9+.-]*:/i.test(source) && imageFor ? imageFor(source) : null;
          if (!href) {
            return <span className="muted small">{source && !/^[a-z][a-z0-9+.-]*:/i.test(source) ? `[image not found: ${source}]` : '[image omitted]'}</span>;
          }
          const width = /^w=(\d+)$/.exec(title ?? '')?.[1];
          // eslint-disable-next-line @next/next/no-img-element
          return <img className="internal-embed" src={href} alt={alt ?? ''} width={width ? Number(width) : undefined} loading="lazy" />;
        },
      }}
    >
      {linked}
    </Markdown>
  );
}
