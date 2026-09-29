import { listClusters } from '@/lib/clusters';
import { reconcileOnBoot } from '@/lib/jobs';
import { Frame } from '@/components/frame/Frame';
import { ClusterSidebar } from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

/** The front page and the new-cluster wizard: the frame, with the clusters where a cluster has its pages. */
export default async function HomeLayout({ children }: { children: React.ReactNode }) {
  // A restart kills any in-flight ingest with it. Settle those records before
  // rendering anything, so nothing shows a progress bar that will never move.
  await reconcileOnBoot();
  const clusters = await listClusters();
  const pages = clusters.reduce((n, cluster) => n + cluster.pageCount, 0);

  return (
    <Frame
      sidebar={<ClusterSidebar clusters={clusters} />}
      status={
        <>
          <span className="statusbar-item">Second Brain</span>
          <span className="statusbar-item detail muted">
            {clusters.length} {clusters.length === 1 ? 'cluster' : 'clusters'} · {pages} {pages === 1 ? 'page' : 'pages'}
          </span>
        </>
      }
    >
      {children}
    </Frame>
  );
}
