import fs from 'node:fs/promises';
import { clusterPath } from './config';
import { readIfPresent } from './clusters';
import { PAGE_DIRS, extractWikilinks, listPages, titleIndex, type Snapshot } from './wiki';

/**
 * The post-ingest check.
 *
 * The agent is asked, in natural language, to update index.md, append to
 * log.md, and link every page it writes. Natural-language instructions are
 * followed probabilistically, so the "Filed" screen cannot be trusted unless
 * something looks at the disk afterwards. This does. It never modifies the
 * wiki; it only reports.
 *
 * Every finding carries a plain-English `detail` so the UI can show it as is.
 */

export type Severity = 'error' | 'warning';

export interface Finding {
  code:
    | 'index-not-updated'
    | 'index-missing-page'
    | 'log-not-updated'
    | 'orphan-page'
    | 'broken-link'
    | 'no-pages-written';
  severity: Severity;
  detail: string;
}

export interface LintResult {
  ok: boolean;
  findings: Finding[];
  checkedAt: string;
}

interface Before {
  index: string | null;
  log: string | null;
  snapshot: Snapshot;
}

/** Capture what the check will compare against. Call before the agent runs. */
export async function beforeIngest(cluster: string, snapshot: Snapshot): Promise<Before> {
  return {
    index: await readIfPresent(clusterPath(cluster, 'index.md')),
    log: await readIfPresent(clusterPath(cluster, 'log.md')),
    snapshot,
  };
}

export async function lintAfterIngest(cluster: string, before: Before): Promise<LintResult> {
  const findings: Finding[] = [];

  const index = await readIfPresent(clusterPath(cluster, 'index.md'));
  const log = await readIfPresent(clusterPath(cluster, 'log.md'));
  const grouped = await listPages(cluster);
  const titles = await titleIndex(cluster);

  const all = PAGE_DIRS.flatMap((dir) => grouped[dir]);
  const changed = new Set<string>();
  for (const ref of all) {
    const raw = await readIfPresent(clusterPath(cluster, `${ref.slug}.md`));
    if (raw === null) continue;
    const previous = before.snapshot.pages.get(ref.slug);
    if (previous === undefined || previous !== fingerprint(raw)) changed.add(ref.slug);
  }

  // 1. Did anything get written at all? An agent that read the source and
  //    decided nothing was worth filing is a legitimate outcome, but the user
  //    must see it as such rather than as a silent success.
  if (changed.size === 0) {
    findings.push({
      code: 'no-pages-written',
      severity: 'warning',
      detail: 'The agent finished without creating or changing any page. Check the source has content the cluster scope covers.',
    });
  }

  // 2. index.md must change whenever a page did.
  if (changed.size > 0 && index === before.index) {
    findings.push({
      code: 'index-not-updated',
      severity: 'error',
      detail: 'Pages were written but index.md did not change. New pages will not be found by the agent or the sidebar until it is updated.',
    });
  }

  // 3. Every page on disk must be listed in the index by title or slug.
  if (index) {
    const lower = index.toLowerCase();
    for (const ref of all) {
      const slugName = ref.slug.split('/')[1];
      const listed =
        lower.includes(`[[${ref.title.toLowerCase()}`) ||
        lower.includes(`[[${slugName.toLowerCase()}`) ||
        lower.includes(`${ref.slug.toLowerCase()}`) ||
        lower.includes(`${slugName.replace(/-/g, ' ').toLowerCase()}`);
      if (!listed) {
        findings.push({
          code: 'index-missing-page',
          severity: 'warning',
          detail: `"${ref.title}" exists on disk but is not listed in index.md.`,
        });
      }
    }
  }

  // 4. log.md must gain an entry.
  if (log === before.log) {
    findings.push({
      code: 'log-not-updated',
      severity: 'warning',
      detail: 'log.md did not gain an entry for this ingest. The record of what changed and when is incomplete.',
    });
  }

  // 5. Links: every wikilink must resolve, and every page must be linked to.
  const inbound = new Set<string>();
  for (const ref of all) {
    const raw = await readIfPresent(clusterPath(cluster, `${ref.slug}.md`));
    if (raw === null) continue;
    for (const target of extractWikilinks(raw)) {
      const slug = titles.get(target.toLowerCase());
      if (!slug) {
        // Only report broken links on pages this ingest touched; older ones
        // belong to a full lint, not to this ingest's report.
        if (changed.has(ref.slug)) {
          findings.push({
            code: 'broken-link',
            severity: 'warning',
            detail: `"${ref.title}" links to [[${target}]], which does not exist yet.`,
          });
        }
        continue;
      }
      if (slug !== ref.slug) inbound.add(slug);
    }
  }
  for (const ref of all) {
    if (changed.has(ref.slug) && !inbound.has(ref.slug)) {
      findings.push({
        code: 'orphan-page',
        severity: 'warning',
        detail: `"${ref.title}" was written but nothing links to it. It is unreachable from the rest of the record.`,
      });
    }
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    findings,
    checkedAt: new Date().toISOString(),
  };
}

/** Same cheap fingerprint as wiki.ts so "changed" means the bytes changed. */
function fingerprint(text: string): string {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return `${text.length}:${sum.toString(36)}`;
}

export { fs };
