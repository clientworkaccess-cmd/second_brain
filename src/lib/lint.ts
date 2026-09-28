import fs from 'node:fs/promises';
import path from 'node:path';
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
    | 'no-pages-written'
    | 'agent-config-file'
    | 'schema-changed'
    | 'source-changed';
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
  /** SCHEMA.md as it was. Every run reads it as its rules, so the agent must not be the one to write it. */
  schema: string | null;
  /** Every file under raw/, by name, as it was. Sources are kept exactly as they were given. */
  sources: Map<string, string>;
  snapshot: Snapshot;
}

/** Capture what the check will compare against. Call before the agent runs. */
export async function beforeIngest(cluster: string, snapshot: Snapshot): Promise<Before> {
  return {
    index: await readIfPresent(clusterPath(cluster, 'index.md')),
    log: await readIfPresent(clusterPath(cluster, 'log.md')),
    schema: await readIfPresent(clusterPath(cluster, 'SCHEMA.md')),
    sources: await sourceFingerprints(cluster),
    snapshot,
  };
}

/** raw/ and everything under it: path from raw/ -> fingerprint of the bytes. */
export async function sourceFingerprints(cluster: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // no raw/ yet: nothing has been filed
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
      else out.set(relPath, fingerprint((await fs.readFile(path.join(dir, entry.name))).toString('latin1')));
    }
  };
  await walk(clusterPath(cluster, 'raw'), '');
  return out;
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

  // 6. Nothing that could steer a later run. The agent is refused these writes
  //    (see the deny rules in claude.ts), and no run loads configuration from
  //    the wiki. Finding such a file anyway means a rule did not hold.
  for (const file of await agentConfigFiles(cluster)) {
    findings.push({
      code: 'agent-config-file',
      severity: 'error',
      detail: `"${file}" is in the wiki. Files of that name can carry instructions into later runs. Remove it and check what wrote it.`,
    });
  }

  // 7. SCHEMA.md is read at the start of every run as the rules for this
  //    cluster. A run that rewrites it has written the rules for the next one.
  const schema = await readIfPresent(clusterPath(cluster, 'SCHEMA.md'));
  if (schema !== before.schema) {
    findings.push({
      code: 'schema-changed',
      severity: 'error',
      detail:
        schema === null
          ? 'SCHEMA.md was removed during this filing. It sets the scope for every later run. Restore it from the last commit.'
          : 'SCHEMA.md was changed during this filing. It sets the scope for every later run, and only a person should change it. Compare it with the last commit.',
    });
  }

  // 8. Sources stay exactly as they were given. The one file that may appear is
  //    the document being filed, which the app puts there itself.
  const sources = await sourceFingerprints(cluster);
  const touched = [...before.sources].filter(([name, was]) => sources.get(name) !== was).map(([name]) => name);
  for (const name of touched.slice(0, 10)) {
    findings.push({
      code: 'source-changed',
      severity: 'error',
      detail: `"raw/${name}" was ${sources.has(name) ? 'changed' : 'removed'} during this filing. Sources are kept as they were given. Restore it from the last commit.`,
    });
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    findings,
    checkedAt: new Date().toISOString(),
  };
}

const STEERING_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', '.mcp.json']);
const STEERING_DIRS = new Set(['.claude']);

/** Files and folders an agent reads as instructions or configuration, anywhere in the cluster. */
export async function agentConfigFiles(cluster: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (name === '.git') continue;
        if (STEERING_DIRS.has(name)) found.push(`${relPath}/`);
        else await walk(path.join(dir, entry.name), relPath);
      } else if (STEERING_FILES.has(name)) {
        found.push(relPath);
      }
    }
  };
  await walk(clusterPath(cluster), '');
  return found.sort();
}

/** Same cheap fingerprint as wiki.ts so "changed" means the bytes changed. */
function fingerprint(text: string): string {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return `${text.length}:${sum.toString(36)}`;
}

export { fs };
