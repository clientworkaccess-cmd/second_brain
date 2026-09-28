import { notFound } from 'next/navigation';
import Link from 'next/link';
import { readPage, titleIndex } from '@/lib/wiki';
import { HttpError } from '@/lib/config';
import { MarkdownView } from '@/components/MarkdownView';
import { Reveal } from '@/components/Reveal';
import { Badge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** One wiki page, with its outbound links rendered as real navigation. */
export default async function WikiPage({
  params,
}: {
  params: Promise<{ cluster: string; slug: string[] }>;
}) {
  const { cluster, slug } = await params;

  let page;
  try {
    page = await readPage(cluster, slug.join('/'));
  } catch (err) {
    if (err instanceof HttpError) notFound();
    throw err;
  }

  const titles = await titleIndex(cluster);

  return (
    <Reveal>
      <article>
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Badge tone="accent">{page.dir}</Badge>
          <Badge>updated {new Date(page.updatedAt).toLocaleDateString()}</Badge>
        </div>

        <MarkdownView source={page.body} cluster={cluster} titles={titles} />

        {page.links.length > 0 && (
          <footer className="mt-14 border-t border-line pt-6">
            <h2 className="mb-3 text-small font-medium uppercase tracking-[0.12em] text-muted/70">
              Links from this page
            </h2>
            <div className="flex flex-wrap gap-2">
              {page.links.map((link) => {
                const target = titles.get(link.toLowerCase());
                return target ? (
                  <Link
                    key={link}
                    href={`/c/${cluster}/${target}`}
                    className="rounded-full border border-line px-3 py-1 text-small text-muted transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    {link}
                  </Link>
                ) : (
                  <span
                    key={link}
                    title="Linked but not written yet"
                    className="rounded-full border border-dashed border-danger/30 px-3 py-1 text-small text-danger/70"
                  >
                    {link}
                  </span>
                );
              })}
            </div>
          </footer>
        )}
      </article>
    </Reveal>
  );
}
