import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { linkifyWikilinks } from '@/lib/wiki';

/**
 * Renders a wiki page.
 *
 * `[[wikilinks]]` are rewritten to real routes before the markdown parser sees
 * them. A link whose target does not exist on disk is rendered visibly dead
 * rather than silently 404ing — an orphan link is a curation signal worth
 * seeing, not hiding.
 */
export function MarkdownView({
  source,
  cluster,
  titles,
}: {
  source: string;
  cluster: string;
  titles: Map<string, string>;
}) {
  const linked = linkifyWikilinks(source, cluster, titles);

  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...rest }) {
            const target = href ?? '';

            if (target.includes('?missing=')) {
              return (
                <span
                  className="cursor-help border-b border-dashed border-error/60 text-error"
                  title="This page is linked but does not exist yet"
                >
                  {children}
                </span>
              );
            }

            if (target.startsWith('/')) {
              return (
                <Link
                  href={target}
                  className="text-lavender underline underline-offset-4 decoration-lavender/40 transition-colors hover:decoration-lavender"
                >
                  {children}
                </Link>
              );
            }

            // External. Never let an ingested document open a tab with a live
            // opener reference back into the app.
            return (
              <a
                href={target}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-lavender underline underline-offset-4 decoration-lavender/40 transition-colors hover:decoration-lavender"
                {...rest}
              >
                {children}
              </a>
            );
          },
          img() {
            // Images inside client documents are untrusted remote references.
            return <span className="font-mono text-small text-muted">[image omitted]</span>;
          },
        }}
      >
        {linked}
      </Markdown>
    </div>
  );
}
