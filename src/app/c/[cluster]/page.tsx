import { FileQuestion } from 'lucide-react';
import { describeCluster } from '@/lib/clusters';
import { outlineOf } from '@/lib/outline';
import { readIndex, readLog, titleIndex, listPages, splitPage, PAGE_DIRS } from '@/lib/wiki';
import { Center } from '@/components/frame/Frame';
import { RightSidebar } from '@/components/frame/RightSidebar';
import { UploadPanel } from '@/components/UploadPanel';
import { MarkdownView } from '@/components/MarkdownView';
import { EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** The cluster's front page: add a document, then the agent's own index.md. */
export default async function ClusterIndex({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const [meta, index, log, titles, pages] = await Promise.all([
    describeCluster(cluster),
    readIndex(cluster),
    readLog(cluster, 12),
    titleIndex(cluster),
    listPages(cluster),
  ]);

  const pageCount = PAGE_DIRS.reduce((n, dir) => n + pages[dir].length, 0);
  const body = index ? splitPage(index).content : null;

  return (
    <>
      <Center scope={cluster} tab={{ href: `/c/${cluster}`, title: 'Index' }} home={`/c/${cluster}`} hasRight>
        <div className="content !pb-0">
          <UploadPanel cluster={cluster} />
        </div>

        {pageCount === 0 ? (
          <div className="content">
            <div className="rounded border border-dashed border-line">
              <EmptyState
                icon={FileQuestion}
                title="This cluster is empty"
                body="Add your first document above. You will see exactly what it created: the pages, and the links between them."
              />
            </div>
          </div>
        ) : body ? (
          <article className="preview">
            <MarkdownView source={body} cluster={cluster} titles={titles} outline={outlineOf(body)} />
          </article>
        ) : (
          <p className="content text-body text-muted">The agent has written pages but no index.md yet.</p>
        )}
      </Center>

      <RightSidebar
        panels={[
          {
            id: 'activity',
            label: 'Activity',
            content:
              log.length === 0 ? (
                <div className="muted pad">Nothing has happened here yet.</div>
              ) : (
                <div className="backlinks">
                  {log.map((entry, i) => (
                    <div key={i} className="backlink-group">
                      <div className="flex items-baseline gap-2 px-1.5">
                        <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={entry.subject}>
                          {entry.subject}
                        </span>
                        <span className="flex-none text-tiny text-faint">
                          {entry.action} · {entry.when}
                        </span>
                      </div>
                      {entry.details.slice(0, 6).map((line, j) => (
                        <div key={j} className="backlink-context">
                          {line.slice(0, 220)}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ),
          },
          {
            id: 'about',
            label: 'About',
            content: (
              <div className="pad">
                <div className="text-body font-semibold text-ink">{meta.title}</div>
                <p className="mt-1.5 text-ui text-muted">{meta.scope}</p>
                <table className="mt-3 text-ui">
                  <tbody>
                    {PAGE_DIRS.map((dir) => (
                      <tr key={dir}>
                        <th className="pr-3 text-left font-medium capitalize text-muted">{dir}</th>
                        <td className="tabular-nums text-ink">{pages[dir].length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
