import fs from 'node:fs/promises';
import path from 'node:path';
import { clusterPath } from './config';
import { readIfPresent } from './files';
import { indexFile, logFile, type Layout } from './layout';
import { pageProblems } from './facets';
import { fingerprint, isCatalogue, loadWiki, resolveLink, type Snapshot } from './wiki';

/**
 * The post-ingest check.
 *
 * The agent is asked, in natural language, to update the index, append to the
 * log, and link every page it writes. Natural-language instructions are
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
    | 'source-changed'
    | 'page-block';
  severity: Severity;
  detail: string;
}

export interface LintResult {
  ok: boolean;
  findings: Finding[];
  checkedAt: string;
}

interface Before {
  layout: Layout;
  index: string | null;
  log: string | null;
  /** The rules file as it was. Every run reads it as its rules, so the agent must not be the one to write it. */
  schema: string | null;
  /** Every file under the sources, by name, as it was. Sources are kept exactly as they were given. */
  sources: Map<string, string>;
  /** Files a person keeps in the wiki's folder that an agent would read as settings, as they were. */
  settings: Map<string, string>;
  snapshot: Snapshot;
}

/** Capture what the check will compare against. Call before the agent runs. */
export async function beforeIngest(cluster: string, snapshot: Snapshot, layout: Layout): Promise<Before> {
  return {
    layout,
    index: await readIfPresent(clusterPath(cluster, indexFile(layout))),
    log: await readIfPresent(clusterPath(cluster, logFile(layout))),
    schema: await readIfPresent(clusterPath(cluster, layout.rulesFile)),
    sources: await sourceFingerprints(cluster, layout),
    settings: await keptSettings(cluster, layout),
    snapshot,
  };
}

/** Read whole up to this size. Past it, the size and the time of the file stand in for its bytes. */
const READ_WHOLE_BYTES = 1024 * 1024;

/**
 * The sources and everything under them: path -> fingerprint.
 *
 * Without the inbox. That is where a person drops what has not been filed yet,
 * at any time, a filing in progress included.
 */
export async function sourceFingerprints(cluster: string, layout: Layout): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await fingerprintsUnder(clusterPath(cluster, layout.rawDir), '', out, (rel) => rel === 'inbox');
  return out;
}

async function fingerprintsUnder(
  dir: string,
  rel: string,
  out: Map<string, string>,
  skip: (relPath: string) => boolean = () => false,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // nothing there yet
  }
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip(relPath)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fingerprintsUnder(full, relPath, out, skip);
      continue;
    }
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    out.set(
      relPath,
      stat.size <= READ_WHOLE_BYTES ? fingerprint((await fs.readFile(full)).toString('latin1')) : `${stat.size}@${stat.mtimeMs}`,
    );
  }
}

export async function lintAfterIngest(cluster: string, before: Before): Promise<LintResult> {
  const { layout } = before;
  const findings: Finding[] = [];
  const indexName = indexFile(layout);
  const logName = logFile(layout);

  const index = await readIfPresent(clusterPath(cluster, indexName));
  const log = await readIfPresent(clusterPath(cluster, logName));
  const wiki = await loadWiki(cluster, { fresh: true });

  const all = [...wiki.entries.values()].filter((entry) => !isCatalogue(entry.slug));
  const changed = new Set<string>();
  for (const entry of all) {
    const previous = before.snapshot.pages.get(entry.slug);
    if (previous === undefined || previous !== entry.fingerprint) changed.add(entry.slug);
  }

  // 1. Did anything get written at all? An agent that read the source and
  //    decided nothing was worth filing is a legitimate outcome, but the user
  //    must see it as such rather than as a silent success.
  if (changed.size === 0) {
    findings.push({
      code: 'no-pages-written',
      severity: 'warning',
      detail: 'The agent finished without creating or changing any page. Check the source has content this wiki covers.',
    });
  }

  // 2. The index must change whenever a page did.
  if (changed.size > 0 && index === before.index) {
    findings.push({
      code: 'index-not-updated',
      severity: 'error',
      detail: `Pages were written but ${indexName} did not change. New pages will not be found by the agent or the sidebar until it is updated.`,
    });
  }

  // 3. Every page on disk must be listed in the index by title or file name.
  if (index) {
    const lower = index.toLowerCase();
    for (const entry of all) {
      const name = (entry.slug.split('/').pop() ?? entry.slug).toLowerCase();
      const listed =
        lower.includes(`[[${entry.title.toLowerCase()}`) ||
        lower.includes(`[[${name}`) ||
        lower.includes(entry.slug.toLowerCase()) ||
        lower.includes(name.replace(/-/g, ' '));
      if (!listed) {
        findings.push({
          code: 'index-missing-page',
          severity: 'warning',
          detail: `"${entry.title}" exists on disk but is not listed in ${indexName}.`,
        });
      }
    }
  }

  // 4. The log must gain an entry.
  if (log === before.log) {
    findings.push({
      code: 'log-not-updated',
      severity: 'warning',
      detail: `${logName} did not gain an entry for this ingest. The record of what changed and when is incomplete.`,
    });
  }

  // 5. Links: every wikilink must resolve, and every page must be linked to.
  const inbound = new Set<string>();
  for (const entry of all) {
    for (const target of entry.links) {
      const slug = resolveLink(wiki.names, target);
      if (!slug) {
        // Only report broken links on pages this ingest touched; older ones
        // belong to a full lint, not to this ingest's report.
        if (changed.has(entry.slug)) {
          findings.push({
            code: 'broken-link',
            severity: 'warning',
            detail: `"${entry.title}" links to [[${target}]], which does not exist yet.`,
          });
        }
        continue;
      }
      if (slug !== entry.slug) inbound.add(slug);
    }
  }
  for (const entry of all) {
    if (changed.has(entry.slug) && !inbound.has(entry.slug)) {
      findings.push({
        code: 'orphan-page',
        severity: 'warning',
        detail: `"${entry.title}" was written but nothing links to it. It is unreachable from the rest of the record.`,
      });
    }
  }

  // 5b. The block at the top of every page this filing touched says what the
  //     rules ask: a type that matches the folder, facets the wiki knows, dates
  //     that are dates. Reported, never refused.
  let reported = 0;
  for (const entry of all) {
    if (!changed.has(entry.slug)) continue;
    for (const problem of pageProblems(entry, layout, wiki.facets)) {
      if (reported++ >= 20) break;
      findings.push({ code: 'page-block', severity: 'warning', detail: `"${entry.title}" ${problem}.` });
    }
  }

  // 6. Nothing that could steer a later run. The agent is refused these writes
  //    (see the deny rules in claude.ts), and no run loads configuration from
  //    the wiki. Finding such a file anyway means a rule did not hold.
  for (const file of await agentConfigFiles(cluster, layout)) {
    findings.push({
      code: 'agent-config-file',
      severity: 'error',
      detail: `"${file}" is in the wiki. Files of that name can carry instructions into later runs. Remove it and check what wrote it.`,
    });
  }
  //    Where a person keeps such files in the folder on purpose, they are
  //    theirs, and stay as they were.
  const settings = await keptSettings(cluster, layout);
  for (const name of new Set([...before.settings.keys(), ...settings.keys()])) {
    if (before.settings.get(name) === settings.get(name)) continue;
    findings.push({
      code: 'agent-config-file',
      severity: 'error',
      detail: `"${name}" was ${!before.settings.has(name) ? 'added' : settings.has(name) ? 'changed' : 'removed'} during this filing. Only a person changes what is in that folder. Compare it with the last commit.`,
    });
  }

  // 7. The rules file is read at the start of every run. A run that rewrites
  //    it has written the rules for the next one.
  const schema = await readIfPresent(clusterPath(cluster, layout.rulesFile));
  if (schema !== before.schema) {
    findings.push({
      code: 'schema-changed',
      severity: 'error',
      detail:
        schema === null
          ? `${layout.rulesFile} was removed during this filing. It sets the rules for every later run. Restore it from the last commit.`
          : `${layout.rulesFile} was changed during this filing. It sets the rules for every later run, and only a person should change it. Compare it with the last commit.`,
    });
  }

  // 8. Sources stay exactly as they were given. The one file that may appear is
  //    the document being filed, which the app puts there itself.
  const sources = await sourceFingerprints(cluster, layout);
  const touched = [...before.sources].filter(([name, was]) => sources.get(name) !== was).map(([name]) => name);
  for (const name of touched.slice(0, 10)) {
    findings.push({
      code: 'source-changed',
      severity: 'error',
      detail: `"${layout.rawDir}/${name}" was ${sources.has(name) ? 'changed' : 'removed'} during this filing. Sources are kept as they were given. Restore it from the last commit.`,
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

/** What a person may keep at the top of the wiki's folder, by layout: the rules, and their own settings. */
function keptAtTop(layout: Layout): Set<string> {
  return layout.id === 'brain' ? new Set([layout.rulesFile.toLowerCase(), '.claude']) : new Set();
}

/**
 * Files and folders an agent reads as instructions or configuration, anywhere
 * in the wiki's folder, except the ones the layout expects at the top of it.
 */
export async function agentConfigFiles(cluster: string, layout: Layout): Promise<string[]> {
  const found: string[] = [];
  const kept = keptAtTop(layout);
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
      if (!rel && kept.has(name)) continue;
      if (entry.isDirectory()) {
        if (name === '.git' || name === 'node_modules') continue;
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

/** The settings a person keeps at the top of the folder, file by file, as they are now. */
async function keptSettings(cluster: string, layout: Layout): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of keptAtTop(layout)) {
    if (!STEERING_DIRS.has(name)) continue; // the rules file has a check of its own
    const inside = new Map<string, string>();
    await fingerprintsUnder(clusterPath(cluster, name), '', inside);
    for (const [file, print] of inside) out.set(`${name}/${file}`, print);
  }
  return out;
}
