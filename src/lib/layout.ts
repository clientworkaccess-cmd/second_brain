import path from 'node:path';
import { clusterPath } from './config';
import { exists } from './files';

/**
 * How a wiki is laid out on disk: which folder holds which kind of page, which
 * file sets the rules, where the sources are kept.
 *
 * There are two layouts. A cluster is what this app creates: SCHEMA.md,
 * index.md and the page folders side by side. A brain is a wiki that was kept
 * by hand with Claude Code before it came here: the rules in CLAUDE.md, the
 * pages one level down in wiki/, a page for every source, links by file name.
 *
 * Nothing records which of the two a folder is. It is read from the folder: a
 * wiki/index.md makes it a brain. Like the list of clusters, which is a
 * readdir, this cannot drift from what is on disk.
 *
 * Everything that used to know the four folder names by heart asks here.
 */

export interface PageType {
  /** `type:` in the block at the top of a page, and `kind` in a plan. */
  type: string;
  /** The folder, from the folder the pages are in. */
  dir: string;
  /** What a reader sees: the name of the folder in the page tree. */
  label: string;
  /** What belongs there, in one line. The planner is told this. */
  holds: string;
}

export interface Layout {
  id: 'cluster' | 'brain';
  /** From the wiki's folder to the folder the pages are in. Empty when they are the same. */
  pagesDir: string;
  /** The file a person writes and every run reads first. The agent cannot change it. */
  rulesFile: string;
  /** Where sources are kept, as they were given. */
  rawDir: string;
  types: PageType[];
  /** How a link is written: by the page's name, [[Mark Chen]], or by its file name, [[mark-chen]]. */
  links: 'name' | 'slug';
  /** The wiki rules every run is given: a file in prompts/. */
  prompt: string;
  /** What filing may write, as permission rules from the agent's working directory. */
  writable: string[];
  /** What is committed after a filing, from the wiki's folder. Empty means everything. */
  tracked: string[];
  /** Whether a source is given the date it was filed at the start of its name. */
  datedSources: boolean;
}

export const CLUSTER: Layout = {
  id: 'cluster',
  pagesDir: '',
  rulesFile: 'SCHEMA.md',
  rawDir: 'raw',
  types: [
    { type: 'entity', dir: 'entities', label: 'Entities', holds: 'People, teams, companies, systems, vendors, products' },
    { type: 'concept', dir: 'concepts', label: 'Concepts', holds: 'Ideas, processes, policies, recurring themes' },
    { type: 'comparison', dir: 'comparisons', label: 'Comparisons', holds: 'Side-by-side assessments of two or more things' },
    { type: 'query', dir: 'queries', label: 'Saved answers', holds: 'Answers to questions that are worth keeping' },
  ],
  links: 'name',
  prompt: 'llm-wiki.md',
  writable: ['Edit(/**)'],
  tracked: [],
  datedSources: false,
};

export const BRAIN: Layout = {
  id: 'brain',
  pagesDir: 'wiki',
  rulesFile: 'CLAUDE.md',
  rawDir: 'raw',
  types: [
    { type: 'source', dir: 'sources', label: 'Sources', holds: 'One summary for each source document, named by the date of the source and a few words: "2026-09-22 Q3 Board Pack"' },
    { type: 'entity', dir: 'entities', label: 'Entities', holds: 'People, companies, clients, vendors, products, tools, places' },
    { type: 'concept', dir: 'concepts', label: 'Concepts', holds: 'Ideas, processes, playbooks, policies, metrics, recurring themes' },
    { type: 'synthesis', dir: 'synthesis', label: 'Synthesis', holds: 'Comparisons, analyses and answers to questions worth keeping' },
  ],
  links: 'slug',
  prompt: 'brain-wiki.md',
  // The pages and nothing beside them: not the rules, not the sources, and not
  // whatever else a person keeps in the folder.
  writable: ['Edit(/wiki/**)'],
  tracked: ['wiki', 'raw', 'CLAUDE.md'],
  datedSources: true,
};

export const LAYOUTS: Layout[] = [CLUSTER, BRAIN];

/** The catalogue and the record. Pages like any other to a reader, and more than that to the app. */
export const INDEX = 'index';
export const LOG = 'log';

export async function layoutOf(cluster: string): Promise<Layout> {
  return (await exists(clusterPath(cluster, BRAIN.pagesDir, `${INDEX}.md`))) ? BRAIN : CLUSTER;
}

/** A path inside the pages, from the wiki's folder, with forward slashes: `wiki/entities/mark-chen.md`. */
export function inPages(layout: Layout, ...rest: string[]): string {
  return path.posix.join(layout.pagesDir, ...rest);
}

export function indexFile(layout: Layout): string {
  return inPages(layout, `${INDEX}.md`);
}

export function logFile(layout: Layout): string {
  return inPages(layout, `${LOG}.md`);
}

/**
 * Folders beside the page folders that are not page folders. In a cluster the
 * sources and the archive sit in the same folder as the pages.
 */
export function isPageFolder(layout: Layout, name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (layout.pagesDir === '' && (name === layout.rawDir || name === 'source' || name === 'node_modules')) return false;
  return true;
}

/** "comparisons" -> "Comparisons", for a folder no layout names. */
export function labelOf(dir: string): string {
  return dir
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}
