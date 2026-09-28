import Link from 'next/link';
import { FolderPlus, Layers, FileText, Clock } from 'lucide-react';
import { listClusters } from '@/lib/clusters';
import { reconcileOnBoot } from '@/lib/jobs';
import { TopBar } from '@/components/TopBar';
import { Reveal, Stagger, StaggerItem, Lift } from '@/components/Reveal';
import { ButtonLink, Card, EmptyState, Badge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // A restart kills any in-flight ingest with it. Settle those records before
  // rendering anything, so nothing shows a progress bar that will never move.
  await reconcileOnBoot();
  const clusters = await listClusters();

  return (
    <div className="min-h-[100dvh]">
      <TopBar>
        <ButtonLink href="/new" variant="primary">
          <FolderPlus className="h-4 w-4" strokeWidth={2} />
          New cluster
        </ButtonLink>
      </TopBar>

      <main className="mx-auto max-w-shell px-6 py-16">
        <Reveal>
          <h1 className="text-hero text-ink">
            Your documents,{' '}
            <span className="font-serif italic text-accent">connected</span>
          </h1>
          <p className="mt-4 max-w-prose text-body">
            Upload what you already have. Each file is read, filed, and linked into the pages
            it belongs to — so the next upload builds on the last one instead of piling up
            beside it.
          </p>
        </Reveal>

        <div className="mt-14">
          {clusters.length === 0 ? (
            <Reveal delay={0.12}>
              <EmptyState
                icon={Layers}
                title="No clusters yet"
                body="A cluster is one area of the business — Operations, Finance, Product. Start with one. It is easier to merge two later than to split one."
                action={
                  <ButtonLink href="/new">
                    <FolderPlus className="h-4 w-4" strokeWidth={2} />
                    Create your first cluster
                  </ButtonLink>
                }
              />
            </Reveal>
          ) : (
            <>
              <h2 className="mb-5 text-small font-medium uppercase tracking-[0.12em] text-muted/70">
                Clusters
              </h2>
              <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {clusters.map((cluster) => (
                  <StaggerItem key={cluster.name} className="h-full">
                    <Lift className="h-full">
                      <Link href={`/c/${cluster.name}`} className="block h-full">
                        <Card className="flex h-full flex-col p-5 transition-colors hover:border-accent/40">
                          <h3 className="text-h2 text-ink">{cluster.title}</h3>
                          <p className="mt-2 flex-1 text-small text-muted line-clamp-3">
                            {cluster.scope}
                          </p>
                          <div className="mt-5 flex flex-wrap items-center gap-2">
                            <Badge tone={cluster.pageCount > 0 ? 'accent' : 'neutral'}>
                              <FileText className="h-3 w-3" strokeWidth={2} />
                              {cluster.pageCount} {cluster.pageCount === 1 ? 'page' : 'pages'}
                            </Badge>
                            {cluster.updatedAt && (
                              <Badge>
                                <Clock className="h-3 w-3" strokeWidth={2} />
                                {new Date(cluster.updatedAt).toLocaleDateString()}
                              </Badge>
                            )}
                          </div>
                        </Card>
                      </Link>
                    </Lift>
                  </StaggerItem>
                ))}
              </Stagger>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
