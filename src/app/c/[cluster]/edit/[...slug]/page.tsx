import { notFound } from 'next/navigation';
import { listImages } from '@/lib/assets';
import { HttpError } from '@/lib/config';
import { inPages, layoutOf } from '@/lib/layout';
import { readPageSource, templateFor } from '@/lib/pages';
import { linkIndex, listPages } from '@/lib/wiki';
import { Center } from '@/components/frame/Frame';
import { PageEditor } from '@/components/PageEditor';

export const dynamic = 'force-dynamic';

/**
 * A page open for editing. A page that does not exist yet is opened with a
 * template, when the address says what to call it (`?title=`); the first save
 * creates it.
 */
export default async function EditPage({
  params,
  searchParams,
}: {
  params: Promise<{ cluster: string; slug: string[] }>;
  searchParams: Promise<{ title?: string }>;
}) {
  const { cluster, slug: parts } = await params;
  const { title } = await searchParams;
  const slug = parts.map((part) => decodeURIComponent(part)).join('/');

  let source;
  try {
    source = await readPageSource(cluster, slug);
  } catch (err) {
    if (err instanceof HttpError) notFound();
    throw err;
  }
  if (!source.exists && !title) notFound();

  const [layout, listing, known, images] = await Promise.all([layoutOf(cluster), listPages(cluster), linkIndex(cluster), listImages(cluster)]);
  const inside = inPages(layout, slug);
  const fromDir = inside.includes('/') ? inside.slice(0, inside.lastIndexOf('/')) : '';
  const pages = [...listing.folders.flatMap((f) => f.pages), ...listing.root];
  // How a link is written in this wiki: by the page's name, or by its file name.
  const links = pages.map((page) => ({ link: layout.links === 'slug' ? (page.slug.split('/').pop() ?? page.slug) : page.title, title: page.title }));
  const text = source.exists ? source.text : await templateFor(cluster, slug, title ?? '');
  const shown = source.exists ? (pages.find((page) => page.slug === slug)?.title ?? slug) : title ?? slug;

  return (
    <Center scope={cluster} tab={{ href: `/c/${cluster}/edit/${slug}`, title: `Editing ${shown}` }} home={`/c/${cluster}`} scroll={false}>
      <PageEditor cluster={cluster} slug={slug} text={text} version={source.version} isNew={!source.exists} links={links} known={[...known]} images={images} fromDir={fromDir} />
    </Center>
  );
}
