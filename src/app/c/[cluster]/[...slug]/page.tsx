import { notFound } from 'next/navigation';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { HttpError } from '@/lib/config';
import { outlineOf, wordCount } from '@/lib/outline';
import { backlinksOf, readPage, titleIndex } from '@/lib/wiki';
import { Center } from '@/components/frame/Frame';
import { RightSidebar } from '@/components/frame/RightSidebar';
import { StatusItems } from '@/components/frame/controls';
import { MarkdownView } from '@/components/MarkdownView';

export const dynamic = 'force-dynamic';

/** One wiki page in the reading view, with what links to it and what it contains beside it. */
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

  const [titles, backlinks] = await Promise.all([titleIndex(cluster), backlinksOf(cluster, page.slug)]);
  const outline = outlineOf(page.body);
  const href = `/c/${cluster}/${page.slug}`;

  return (
    <>
      <Center scope={cluster} tab={{ href, title: page.title }} home={`/c/${cluster}`} hasRight>
        <article className="preview">
          <Properties properties={page.properties} />
          <MarkdownView source={page.body} cluster={cluster} titles={titles} outline={outline} />
        </article>
      </Center>

      <RightSidebar
        panels={[
          {
            id: 'backlinks',
            label: 'Backlinks',
            content:
              backlinks.length === 0 ? (
                <div className="muted pad">No other page links here.</div>
              ) : (
                <div className="backlinks">
                  {backlinks.map((link) => (
                    <div key={link.slug} className="backlink-group">
                      <Link className="backlink-source" href={`/c/${cluster}/${link.slug}`}>
                        <FileText size={14} className="flex-none text-faint" />
                        <span>{link.title}</span>
                      </Link>
                      {link.context && <div className="backlink-context">{link.context}</div>}
                    </div>
                  ))}
                </div>
              ),
          },
          {
            id: 'outline',
            label: 'Outline',
            content:
              outline.length === 0 ? (
                <div className="muted pad">This page has no headings.</div>
              ) : (
                <nav className="outline-list" aria-label="Outline">
                  {outline.map((heading) => (
                    <a
                      key={heading.id}
                      className="outline-item"
                      href={`#${heading.id}`}
                      style={{ paddingLeft: 8 + (heading.depth - 1) * 12 }}
                    >
                      {heading.text}
                    </a>
                  ))}
                </nav>
              ),
          },
          {
            id: 'links',
            label: 'Links',
            content:
              page.links.length === 0 ? (
                <div className="muted pad">This page links nowhere.</div>
              ) : (
                <nav className="outline-list" aria-label="Links from this page">
                  {page.links.map((link) => {
                    const target = titles.get(link.toLowerCase());
                    return target ? (
                      <Link key={link} className="outline-item" href={`/c/${cluster}/${target}`}>
                        {link}
                      </Link>
                    ) : (
                      <span
                        key={link}
                        className="outline-item muted"
                        style={{ cursor: 'help', textDecoration: 'underline dashed', textUnderlineOffset: 3 }}
                        title="Linked but not written yet"
                      >
                        {link}
                      </span>
                    );
                  })}
                </nav>
              ),
          },
        ]}
      />

      <StatusItems>
        <span className="statusbar-item muted">
          {backlinks.length} {backlinks.length === 1 ? 'backlink' : 'backlinks'}
        </span>
        <span className="statusbar-item muted">{wordCount(page.body)} words</span>
        <span className="statusbar-item muted">updated {page.updatedAt.slice(0, 10)}</span>
      </StatusItems>
    </>
  );
}

/** The block at the top of the page, as the desktop app shows it. */
function Properties({ properties }: { properties: [string, string][] }) {
  if (properties.length === 0) return null;
  return (
    <details className="properties" open>
      <summary>Properties</summary>
      <table>
        <tbody>
          {properties.map(([name, value]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>
                {name === 'tags' ? (
                  <span className="flex flex-wrap gap-1">
                    {value
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean)
                      .map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                  </span>
                ) : (
                  value
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
