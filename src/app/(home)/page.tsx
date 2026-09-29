import Link from 'next/link';
import { FolderPlus, Layers } from 'lucide-react';
import { listClusters } from '@/lib/clusters';
import { Center } from '@/components/frame/Frame';
import { Mark } from '@/components/Logo';
import { ButtonLink, EmptyState, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const clusters = await listClusters();

  return (
    <Center tab={{ href: '/', title: 'Clusters' }}>
      <div className="content">
        <header className="flex items-start gap-3">
          <Mark size={36} />
          <div className="min-w-0 flex-1">
            <h1 className="text-display font-bold text-ink">Second Brain</h1>
            <p className="mt-1 max-w-prose text-body text-muted">
              Upload what you already have. Each document is read, filed, and linked into the pages it
              belongs to, so the next one builds on the last instead of piling up beside it.
            </p>
          </div>
          <ButtonLink href="/new" className="flex-none">
            <FolderPlus size={15} />
            New cluster
          </ButtonLink>
        </header>

        {clusters.length === 0 ? (
          <div className="mt-8 rounded border border-dashed border-line">
            <EmptyState
              icon={Layers}
              title="No clusters yet"
              body="A cluster is one area of the business: Operations, Finance, Product. Start with one. It is easier to merge two later than to split one."
              action={
                <ButtonLink href="/new">
                  <FolderPlus size={15} />
                  Create your first cluster
                </ButtonLink>
              }
            />
          </div>
        ) : (
          <section className="mt-8">
            <SectionTitle>Clusters</SectionTitle>
            <ul className="mt-2 divide-y divide-line rounded border border-line bg-panel">
              {clusters.map((cluster) => (
                <li key={cluster.name}>
                  <Link href={`/c/${cluster.name}`} className="flex items-baseline gap-4 px-3.5 py-3 hover:bg-hover">
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-semibold text-ink">{cluster.title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-ui text-muted">{cluster.scope}</span>
                    </span>
                    <span className="flex-none text-right text-small text-muted">
                      <span className="block tabular-nums">
                        {cluster.pageCount} {cluster.pageCount === 1 ? 'page' : 'pages'}
                      </span>
                      {cluster.updatedAt && (
                        <span className="block text-faint">{cluster.updatedAt.slice(0, 10)}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Center>
  );
}
