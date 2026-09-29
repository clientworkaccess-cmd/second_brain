import { notFound } from 'next/navigation';
import Link from 'next/link';
import { describeCluster, exists } from '@/lib/clusters';
import { clusterPath, assertClusterName } from '@/lib/config';
import { buildGraph } from '@/lib/graph';
import { listPages, PAGE_DIRS } from '@/lib/wiki';
import { Frame } from '@/components/frame/Frame';
import { PageSidebar } from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

export default async function ClusterLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ cluster: string }>;
}) {
  const { cluster: raw } = await params;

  let cluster: string;
  try {
    cluster = assertClusterName(raw);
  } catch {
    notFound();
  }

  if (!(await exists(clusterPath(cluster)))) notFound();

  const [meta, pages, graph] = await Promise.all([describeCluster(cluster), listPages(cluster), buildGraph(cluster)]);
  const pageCount = PAGE_DIRS.reduce((n, dir) => n + pages[dir].length, 0);

  return (
    <Frame
      sidebar={<PageSidebar cluster={cluster} pages={pages} />}
      status={
        <>
          <Link className="statusbar-item" href={`/c/${cluster}`} title={meta.scope}>
            {meta.title}
          </Link>
          <span className="statusbar-item detail muted">
            {pageCount} {pageCount === 1 ? 'page' : 'pages'} · {graph.links.length}{' '}
            {graph.links.length === 1 ? 'link' : 'links'}
          </span>
        </>
      }
    >
      {children}
    </Frame>
  );
}
