import { notFound } from 'next/navigation';
import Link from 'next/link';
import { FileText, PenLine } from 'lucide-react';
import { listImages } from '@/lib/assets';
import { HttpError } from '@/lib/config';
import { inPages, layoutOf } from '@/lib/layout';
import { outlineOf, wordCount } from '@/lib/outline';
import { backlinksOf, linkIndex, readPage } from '@/lib/wiki';
import { pageHref, resolveLink } from '@/lib/wikilinks';
import { Center } from '@/components/frame/Frame';
import { RightSidebar } from '@/components/frame/RightSidebar';
import { StatusItems } from '@/components/frame/controls';
import { MarkdownView } from '@/components/MarkdownView';
import { PageActions } from '@/components/PageActions';

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
    page = await readPage(cluster, slug.map((part) => decodeURIComponent(part)).join('/'));
  } catch (err) {
    if (err instanceof HttpError) notFound();
    throw err;
  }

  const [titles, backlinks, images, layout] = await Promise.all([linkIndex(cluster), backlinksOf(cluster, page.slug), listImages(cluster), layoutOf(cluster)]);
  const inside = inPages(layout, page.slug);
  const fromDir = inside.includes('/') ? inside.slice(0, inside.lastIndexOf('/')) : '';
  const outline = outlineOf(page.body);
  const href = pageHref(cluster, page.slug);

  return (
    <>
      <Center scope={cluster} tab={{ href, title: page.title }} home={`/c/${cluster}`} hasRight>
        <article className="preview">
          <Properties cluster={cluster} properties={page.properties} facets={page.facets} problems={page.problems} />
          <MarkdownView source={page.body} cluster={cluster} titles={titles} outline={outline} images={images} fromDir={fromDir} />
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
                      <Link className="backlink-source" href={pageHref(cluster, link.slug)}>
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
                    const target = resolveLink(titles, link);
                    return target ? (
                      <Link key={link} className="outline-item" href={pageHref(cluster, target)}>
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
        <Link className="statusbar-item edit-link" href={`/c/${cluster}/edit/${page.slug.split('/').map(encodeURIComponent).join('/')}`} title="Open this page in the editor">
          <PenLine size={12} />
          Edit
        </Link>
        <PageActions cluster={cluster} slug={page.slug} title={page.title} backlinks={backlinks.length} />
      </StatusItems>
    </>
  );
}

/**
 * The block at the top of the page, as the desktop app shows it. A facet's
 * values are links to the pages that share them; tags are chips; and what the
 * rules would find wrong with the block is said under it.
 */
function Properties({
  cluster,
  properties,
  facets,
  problems,
}: {
  cluster: string;
  properties: [string, string][];
  facets: Record<string, string[]>;
  problems: string[];
}) {
  if (properties.length === 0 && problems.length === 0) return null;
  const chips = (name: string, value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return (
    <details className="properties" open>
      <summary>Properties</summary>
      {properties.length > 0 && (
        <table>
          <tbody>
            {properties.map(([name, value]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>
                  {name in facets ? (
                    <span className="flex flex-wrap gap-1">
                      {chips(name, value).map((item) => (
                        <Link key={item} className="tag" href={`/c/${cluster}?${encodeURIComponent(name)}=${encodeURIComponent(item.toLowerCase())}`} title={`Every page with this ${name}`}>
                          {item}
                        </Link>
                      ))}
                    </span>
                  ) : name === 'tags' ? (
                    <span className="flex flex-wrap gap-1">
                      {chips(name, value).map((tag) => (
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
      )}
      {problems.length > 0 && (
        <ul className="properties-problems" aria-label="What the rules would change about this block">
          {problems.map((problem) => (
            <li key={problem}>This page {problem}.</li>
          ))}
        </ul>
      )}
    </details>
  );
}
