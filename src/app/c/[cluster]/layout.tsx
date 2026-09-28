import { notFound } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, BookOpen, Share2 } from 'lucide-react';
import { describeCluster, exists } from '@/lib/clusters';
import { clusterPath, assertClusterName } from '@/lib/config';
import { listPages } from '@/lib/wiki';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ButtonLink } from '@/components/ui';

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

  const [meta, pages] = await Promise.all([describeCluster(cluster), listPages(cluster)]);

  return (
    <div className="min-h-[100dvh]">
      <TopBar>
        <ButtonLink href={`/c/${cluster}`} variant="quiet">
          <BookOpen className="h-4 w-4" strokeWidth={2} />
          <span className="hidden sm:inline">Wiki</span>
        </ButtonLink>
        <ButtonLink href={`/c/${cluster}/graph`} variant="quiet">
          <Share2 className="h-4 w-4" strokeWidth={2} />
          <span className="hidden sm:inline">Graph</span>
        </ButtonLink>
        <ButtonLink href={`/c/${cluster}/ask`} variant="primary">
          <MessageSquare className="h-4 w-4" strokeWidth={2} />
          Ask
        </ButtonLink>
      </TopBar>

      <div className="mx-auto flex max-w-shell gap-10 px-6 py-10">
        <Sidebar cluster={cluster} pages={pages} />

        <main className="min-w-0 flex-1">
          <div className="mb-8">
            <Link
              href="/"
              className="text-small text-muted/60 transition-colors hover:text-muted"
            >
              All clusters
            </Link>
            <h1 className="mt-1.5 text-h1 text-ink">{meta.title}</h1>
            <p className="mt-2 max-w-prose text-small text-muted">{meta.scope}</p>
          </div>

          {children}
        </main>
      </div>
    </div>
  );
}
