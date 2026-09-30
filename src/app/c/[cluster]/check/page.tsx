import Link from 'next/link';
import { ListChecks, TriangleAlert } from 'lucide-react';
import { checkWiki, type Remark } from '@/lib/lint';
import { readPage } from '@/lib/wiki';
import { pageHref } from '@/lib/wikilinks';
import { Center } from '@/components/frame/Frame';
import { StatusItems } from '@/components/frame/controls';
import { EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The whole wiki, held to its rules: what the rules of a hand-kept wiki call
 * a lint. Every page, the index both ways, every block. Nothing is changed
 * here; a person reads the report and decides.
 */

const KINDS: { code: Remark['code']; title: string; what: string }[] = [
  { code: 'agent-config-file', title: 'Files that would steer a run', what: 'Remove them, and find what wrote them.' },
  { code: 'index-entry-to-nothing', title: 'Index entries that lead nowhere', what: 'The page was renamed, removed, or never written.' },
  { code: 'index-missing-page', title: 'Pages the index does not list', what: 'The agent finds pages through the index. These it cannot.' },
  { code: 'often-mentioned', title: 'Mentioned often, but no page', what: 'Several pages link to a page nobody has written. It may be worth one.' },
  { code: 'broken-link', title: 'Links to pages that do not exist', what: 'A link the agent made to a page it never wrote, or a name that does not match.' },
  { code: 'orphan-page', title: 'Pages nothing links to', what: 'Reachable from the index only.' },
  { code: 'page-block', title: 'Blocks that break the rules', what: 'A type, a facet, a date or a confidence the rules do not allow.' },
];

export default async function CheckPage({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const report = await checkWiki(cluster);
  const tab = { href: `/c/${cluster}/check`, title: 'Check' };

  const groups = KINDS.map((kind) => ({ ...kind, remarks: report.remarks.filter((r) => r.code === kind.code) })).filter((g) => g.remarks.length > 0);
  const titles = new Map<string, string>();
  for (const remark of report.remarks) {
    if (remark.slug && !titles.has(remark.slug)) {
      titles.set(remark.slug, await readPage(cluster, remark.slug).then((page) => page.title).catch(() => remark.slug!));
    }
  }

  return (
    <>
      <Center scope={cluster} tab={tab} home={`/c/${cluster}`}>
        <div className="content">
          <header className="flex items-start gap-3">
            <ListChecks className="mt-1 flex-none text-accent" size={22} />
            <div className="min-w-0 flex-1">
              <h1 className="text-title font-semibold text-ink">The wiki, held to its rules</h1>
              <p className="mt-1 max-w-prose text-body text-muted">
                {report.pages} {report.pages === 1 ? 'page' : 'pages'}, every link both ways, the index both ways, every block.
                Nothing is changed here.
              </p>
            </div>
          </header>

          {groups.length === 0 ? (
            <div className="mt-6 rounded border border-dashed border-line">
              <EmptyState icon={ListChecks} title="Nothing to report" body="Every page is linked, every link leads somewhere, the index is complete, and every block follows the rules." />
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {groups.map((group) => (
                <section key={group.code} aria-labelledby={`check-${group.code}`}>
                  <h2 id={`check-${group.code}`} className="flex items-baseline gap-2 text-body font-semibold text-ink">
                    {group.title}
                    <span className="text-small font-normal tabular-nums text-muted">{group.remarks.length}</span>
                  </h2>
                  <p className="mt-0.5 text-ui text-muted">{group.what}</p>
                  <ul className="mt-2 space-y-1">
                    {group.remarks.map((remark, i) => (
                      <li key={i} className="flex items-start gap-2 text-ui">
                        <TriangleAlert className={`mt-0.5 flex-none ${remark.severity === 'error' ? 'text-danger' : 'text-warning'}`} size={14} />
                        <span className="min-w-0">
                          {remark.detail}
                          {remark.slug && (
                            <>
                              {' '}
                              <Link className="text-link hover:underline" href={pageHref(cluster, remark.slug)}>
                                Open {titles.get(remark.slug) ?? remark.slug}
                              </Link>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </Center>
      <StatusItems>
        <span className="statusbar-item muted">
          {report.remarks.length === 0 ? 'nothing to report' : `${report.remarks.length} ${report.remarks.length === 1 ? 'remark' : 'remarks'}`}
        </span>
      </StatusItems>
    </>
  );
}
