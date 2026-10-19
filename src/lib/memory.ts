import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_DIR } from './config';
import { readIfPresent } from './files';

/**
 * What the owner has taught the brain about how they want things: their preferences,
 * their corrections, their feedback on answers. Learned in the background after
 * each conversation turn (lib/learn.ts), never shown in the app, and given to
 * every conversation turn so the agent answers the way he asked last time.
 *
 * It is not a second wiki. Facts about the business live in the pages; this
 * holds how the owner wants to be answered. Where the two disagree on a fact, the
 * pages win.
 *
 * Two tiers, in Markdown because it is read by a model on every turn and costs
 * fewer tokens than JSON:
 *
 *   memory/core.md            always given to the agent: the entries, and one
 *                             line for each topic file
 *   memory/topics/<slug>.md   entries about one subject (how the owner weighs a
 *                             deal), read by the agent only when a message
 *                             touches it
 *   memory/history/           every earlier version, so a bad entry can be
 *                             rolled back on the server
 *
 * Starts empty. Nothing here is written by the agent that answers; only the
 * app writes it, from the operations the learning run returns.
 */

export type MemoryKind = 'preference' | 'correction' | 'feedback';

export interface MemoryEntry {
  /** YYYY-MM-DD, when it was learned or last changed. */
  date: string;
  kind: MemoryKind;
  text: string;
}

export interface MemoryTopic {
  slug: string;
  /** One line: what the topic holds, so the agent knows when to read it. */
  about: string;
  entries: MemoryEntry[];
}

export interface Memory {
  core: MemoryEntry[];
  topics: MemoryTopic[];
}

/** Past this many core entries, the learning run is asked to consolidate. */
export const CORE_MAX = 60;
/** Past this many entries in a topic, the same. */
export const TOPIC_MAX = 80;
const ENTRY_MAX = 300;
const ABOUT_MAX = 120;
const TOPICS_MAX = 20;
const HISTORY_KEEP = 200;

const KINDS: readonly MemoryKind[] = ['preference', 'correction', 'feedback'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEP = ' · ';

export const TOPICS_DIR = path.join(MEMORY_DIR, 'topics');
const CORE_FILE = path.join(MEMORY_DIR, 'core.md');
const HISTORY_DIR = path.join(MEMORY_DIR, 'history');

export function emptyMemory(): Memory {
  return { core: [], topics: [] };
}

// ------------------------------------------------------------------ format

/** One entry's text, made safe to keep on one line. Empty when there is nothing left. */
export function cleanText(text: unknown, max = ENTRY_MAX): string {
  if (typeof text !== 'string') return '';
  const one = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/^[-*•\s]+/, '').trim();
  // The separator is what splits a line into its parts.
  const safe = one.replace(/ · /g, ' - ');
  return safe.length > max ? `${safe.slice(0, max - 1).trimEnd()}…` : safe;
}

const ENTRY_LINE = /^- (\d{4}-\d{2}-\d{2}) · (preference|correction|feedback) · (.+)$/;
const TOPIC_LINE = /^- topic · ([a-z0-9][a-z0-9-]{0,39}) · (.+)$/;

/** Entries from a file's lines; anything else in the file is ignored. */
export function parseEntries(markdown: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(ENTRY_LINE);
    if (m) out.push({ date: m[1], kind: m[2] as MemoryKind, text: m[3].trim() });
  }
  return out;
}

/** The topic lines of core.md. */
export function parseTopicIndex(markdown: string): { slug: string; about: string }[] {
  const out: { slug: string; about: string }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(TOPIC_LINE);
    if (m) out.push({ slug: m[1], about: m[2].trim() });
  }
  return out;
}

const entryLine = (e: MemoryEntry): string => `- ${e.date}${SEP}${e.kind}${SEP}${e.text}`;

export function renderCore(memory: Memory): string {
  return [
    '# What the owner has taught the brain',
    '',
    '<!-- Kept by the app, learned from the owner\'s conversations. One line each: date · kind · what. -->',
    '',
    '## Entries',
    '',
    ...memory.core.map(entryLine),
    '',
    '## Topics',
    '',
    ...memory.topics.map((t) => `- topic${SEP}${t.slug}${SEP}${t.about}`),
    '',
  ].join('\n');
}

export function renderTopic(topic: MemoryTopic): string {
  return [`# ${topic.slug}`, '', topic.about, '', ...topic.entries.map(entryLine), ''].join('\n');
}

// ------------------------------------------------------------- operations

export type MemoryOp =
  | { op: 'add'; topic?: string; kind: MemoryKind; text: string }
  | { op: 'update'; topic?: string; index: number; text: string; kind?: MemoryKind }
  | { op: 'delete'; topic?: string; index: number }
  | { op: 'topic'; topic: string; about: string };

/**
 * The operations a learning run returned, from its text: the first JSON object
 * in it with an `ops` list. Anything that does not hold together is dropped,
 * never thrown: a run that said something else changes nothing.
 */
export function parseOps(output: string): MemoryOp[] {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (raw as { ops?: unknown })?.ops;
  if (!Array.isArray(list)) return [];
  const ops: MemoryOp[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const topic = typeof o.topic === 'string' && o.topic.trim() ? o.topic.trim().toLowerCase() : undefined;
    if (topic !== undefined && !SLUG.test(topic)) continue;
    const kind = KINDS.includes(o.kind as MemoryKind) ? (o.kind as MemoryKind) : undefined;
    const index = typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 1 ? o.index : undefined;
    switch (o.op) {
      case 'add': {
        const text = cleanText(o.text);
        if (text) ops.push({ op: 'add', topic, kind: kind ?? 'preference', text });
        break;
      }
      case 'update': {
        const text = cleanText(o.text);
        if (text && index) ops.push({ op: 'update', topic, index, text, kind });
        break;
      }
      case 'delete':
        if (index) ops.push({ op: 'delete', topic, index });
        break;
      case 'topic': {
        const about = cleanText(o.about, ABOUT_MAX);
        if (topic && about) ops.push({ op: 'topic', topic, about });
        break;
      }
    }
  }
  return ops;
}

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The memory with the operations applied, and how many changed it.
 *
 * Indexes are the 1-based numbers the learning run was shown, so updates and
 * deletions are applied to the lists as they were shown, before anything is
 * added. A topic that ends up empty is dropped. An entry that says what another
 * already says is not added twice.
 */
export function applyOps(memory: Memory, ops: MemoryOp[], today: string): { memory: Memory; changed: number } {
  const core: (MemoryEntry | null)[] = memory.core.map((e) => ({ ...e }));
  const topics = new Map<string, { about: string; entries: (MemoryEntry | null)[] }>(
    memory.topics.map((t) => [t.slug, { about: t.about, entries: t.entries.map((e) => ({ ...e })) }]),
  );
  let changed = 0;
  const listOf = (topic?: string): (MemoryEntry | null)[] | null => (topic === undefined ? core : topics.get(topic)?.entries ?? null);

  // Topics described first, so an add to a new topic has somewhere to go.
  for (const op of ops) {
    if (op.op !== 'topic') continue;
    const existing = topics.get(op.topic);
    if (existing) {
      if (existing.about !== op.about) {
        existing.about = op.about;
        changed++;
      }
    } else if (topics.size < TOPICS_MAX) {
      topics.set(op.topic, { about: op.about, entries: [] });
      changed++;
    }
  }
  for (const op of ops) {
    if (op.op !== 'update' && op.op !== 'delete') continue;
    const list = listOf(op.topic);
    const at = op.index - 1;
    if (!list || at >= list.length || !list[at]) continue;
    if (op.op === 'delete') list[at] = null;
    else list[at] = { date: today, kind: op.kind ?? (list[at] as MemoryEntry).kind, text: op.text };
    changed++;
  }
  for (const op of ops) {
    if (op.op !== 'add') continue;
    let list = listOf(op.topic);
    // An add to a topic nobody described yet: described by its name.
    if (!list && op.topic && topics.size < TOPICS_MAX) {
      topics.set(op.topic, { about: op.topic.replace(/-/g, ' '), entries: [] });
      list = listOf(op.topic);
    }
    if (!list) continue;
    if (list.some((e) => e && norm(e.text) === norm(op.text))) continue;
    list.push({ date: today, kind: op.kind, text: op.text });
    changed++;
  }

  const out: Memory = {
    core: core.filter((e): e is MemoryEntry => e !== null),
    topics: [...topics.entries()]
      .map(([slug, t]) => ({ slug, about: t.about, entries: t.entries.filter((e): e is MemoryEntry => e !== null) }))
      .filter((t) => t.entries.length > 0),
  };
  return { memory: out, changed };
}

/** Whether the memory is past the size the learning run should consolidate at. */
export function needsConsolidating(memory: Memory): boolean {
  return memory.core.length > CORE_MAX || memory.topics.some((t) => t.entries.length > TOPIC_MAX);
}

// ---------------------------------------------------------- what is given

/**
 * What a conversation turn is told of the memory, for the system prompt. Empty
 * while there is nothing in it.
 */
export function memoryContext(memory: Memory, topicsDir: string = TOPICS_DIR): string {
  if (memory.core.length === 0 && memory.topics.length === 0) return '';
  const lines = ['## What the owner has told you before', ''];
  if (memory.core.length > 0) {
    lines.push(
      'The owner told you these in earlier conversations. Follow them: they are about how they want you to work and answer.',
      'They are not facts about the business. For facts, the brain is right; if an entry here disagrees with the brain, the brain wins.',
      '',
      ...memory.core.map((e) => `- ${e.text} (${e.kind}, ${e.date})`),
      '',
    );
  }
  if (memory.topics.length > 0) {
    lines.push(
      'More of what the owner has told you, by subject. When a message touches one of these, read that file before you answer (you may read it; never write it):',
      '',
      ...memory.topics.map((t) => `- ${t.about}: ${path.join(topicsDir, `${t.slug}.md`)}`),
      '',
    );
  }
  return lines.join('\n');
}

/** The memory as the learning run is shown it: numbered, so it can say which entry it means. */
export function memoryForLearner(memory: Memory, topicsShown: string[]): string {
  const lines: string[] = ['CORE (always given to the assistant):'];
  if (memory.core.length === 0) lines.push('(empty)');
  memory.core.forEach((e, i) => lines.push(`${i + 1}. [${e.kind}, ${e.date}] ${e.text}`));
  lines.push('', 'TOPICS (each read only when a message touches it):');
  if (memory.topics.length === 0) lines.push('(none)');
  for (const t of memory.topics) {
    lines.push(`- ${t.slug}: ${t.about} (${t.entries.length} entries)`);
    if (topicsShown.includes(t.slug)) t.entries.forEach((e, i) => lines.push(`    ${i + 1}. [${e.kind}, ${e.date}] ${e.text}`));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ store

export async function readMemory(dir: string = MEMORY_DIR): Promise<Memory> {
  const core = await readIfPresent(path.join(dir, 'core.md'));
  if (core === null) return emptyMemory();
  const topics: MemoryTopic[] = [];
  for (const { slug, about } of parseTopicIndex(core)) {
    const text = await readIfPresent(path.join(dir, 'topics', `${slug}.md`));
    topics.push({ slug, about, entries: text === null ? [] : parseEntries(text) });
  }
  return { core: parseEntries(core), topics };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

/**
 * The memory written, every file that changes kept first under history/ as it
 * was. A topic no longer in the memory has its file removed (and kept in
 * history like the rest).
 */
export async function writeMemory(memory: Memory, now: Date = new Date(), dir: string = MEMORY_DIR): Promise<void> {
  const historyDir = path.join(dir, 'history');
  await fs.mkdir(historyDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const keep = async (file: string, name: string): Promise<void> => {
    const before = await readIfPresent(file);
    if (before !== null) await fs.writeFile(path.join(historyDir, `${stamp}-${name}`), before, { encoding: 'utf8', mode: 0o600 });
  };

  const topicsDir = path.join(dir, 'topics');
  const wanted = new Set(memory.topics.map((t) => `${t.slug}.md`));
  const present = await fs.readdir(topicsDir).catch(() => [] as string[]);
  for (const name of present) {
    if (!name.endsWith('.md') || wanted.has(name)) continue;
    await keep(path.join(topicsDir, name), `topic-${name}`);
    await fs.rm(path.join(topicsDir, name), { force: true });
  }
  for (const topic of memory.topics) {
    const file = path.join(topicsDir, `${topic.slug}.md`);
    const text = renderTopic(topic);
    if ((await readIfPresent(file)) === text) continue;
    await keep(file, `topic-${topic.slug}.md`);
    await writeAtomic(file, text);
  }
  const coreFile = path.join(dir, 'core.md');
  await keep(coreFile, 'core.md');
  await writeAtomic(coreFile, renderCore(memory));

  // History is for rolling back a recent mistake, not an archive.
  const old = (await fs.readdir(historyDir).catch(() => [] as string[])).sort();
  for (const name of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) await fs.rm(path.join(historyDir, name), { force: true });
}

export { CORE_FILE, HISTORY_DIR };
