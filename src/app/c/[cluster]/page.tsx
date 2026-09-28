import { FileQuestion, ScrollText } from 'lucide-react';
import { readIndex, readLog, titleIndex, listPages, PAGE_DIRS } from '@/lib/wiki';
import { UploadPanel } from '@/components/UploadPanel';
import { MarkdownView } from '@/components/MarkdownView';
import { Reveal } from '@/components/Reveal';
import { Card, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** The cluster's front page: upload, then the agent's own index.md catalog. */
export default async function ClusterIndex({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const [index, log, titles, pages] = await Promise.all([
    readIndex(cluster),
    readLog(cluster, 6),
    titleIndex(cluster),
    listPages(cluster),
  ]);

  const pageCount = PAGE_DIRS.reduce((n, dir) => n + pages[dir].length, 0);

  return (
    <div className="space-y-10">
      <UploadPanel cluster={cluster} />

      {pageCount === 0 ? (
        <Reveal delay={0.12}>
          <EmptyState
            icon={FileQuestion}
            title="This cluster is empty"
            body="Add your first document above. You will see exactly what it created — the pages, and the links between them."
          />
        </Reveal>
      ) : (
        <Reveal delay={0.12}>
          <section>
            <h2 className="mb-4 text-small font-medium uppercase tracking-[0.12em] text-muted/70">
              Index
            </h2>
            {index ? (
              <MarkdownView source={index} cluster={cluster} titles={titles} />
            ) : (
              <p className="text-small text-muted/70">
                The agent has written pages but no index.md yet.
              </p>
            )}
          </section>
        </Reveal>
      )}

      {log.length > 0 && (
        <Reveal delay={0.24}>
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-small font-medium uppercase tracking-[0.12em] text-muted/70">
              <ScrollText className="h-3.5 w-3.5" strokeWidth={2} />
              Recent activity
            </h2>
            <Card className="divide-y divide-line">
              {log.map((entry, i) => (
                <div key={i} className="px-4 py-3">
                  {entry.when && (
                    <span className="mr-2 font-mono text-[0.75rem] text-muted/50">{entry.when}</span>
                  )}
                  <span className="text-small">{entry.raw.replace(/^[-*#]\s*/, '').slice(0, 220)}</span>
                </div>
              ))}
            </Card>
          </section>
        </Reveal>
      )}
    </div>
  );
}
