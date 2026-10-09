import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONVERSATIONS_DIR, HttpError, assertClusterName } from './config';
import { readIfPresent } from './files';

/**
 * Conversations with a wiki, kept by the app.
 *
 * Claude Code keeps a session of its own for each conversation, and a question
 * resumes it, which is what lets the agent remember what was said. But that
 * session is the binary's to keep: it is cleaned up after a while, and lost
 * when the server moves. This file is the record that is not lost. Every
 * question and answer is here; when the binary has forgotten, the next question
 * is given a recap from here (lib/chat.ts recapPrompt) and the conversation
 * carries on.
 *
 * One JSON file per conversation under .dashboard/conversations/<wiki>/, out of
 * the wiki's folder, where the agent works. Shared by every browser, since
 * there is one login.
 */

export type ConversationMode = 'discuss' | 'work';

export interface Finding {
  severity: 'error' | 'warning';
  detail: string;
}

export interface ConversationTurn {
  at: string;
  question: string;
  answer: string;
  sources: string[];
  /** Discuss: read only. Work: may change the wiki. */
  mode: ConversationMode;
  /** The alias asked for, or null for the server's. */
  model: string | null;
  /** What the binary reported it ran as. */
  answeredBy: string | null;
  /** Pages created, changed or removed by this turn, by slug. */
  wrote: string[];
  /** The restore point made after a turn that wrote; undone by reverting it. */
  commit: string | null;
  undoCommit: string | null;
  /** What the check after a writing turn found. */
  findings: Finding[];
  error: string | null;
}

export interface ConversationRecord {
  id: string;
  cluster: string;
  title: string;
  /** Whether a person named it; until then the first question names it. */
  named: boolean;
  createdAt: string;
  updatedAt: string;
  /** The last ones chosen, so a conversation reopens as it was left. */
  mode: ConversationMode;
  model: string | null;
  /** Claude Code's own session for this conversation. `started`: it has answered once, so the next question resumes it. */
  session: { id: string; started: boolean };
  turns: ConversationTurn[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
  wrote: boolean;
  mode: ConversationMode;
}

export const UNTITLED = 'New conversation';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_MAX = 80;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/** A title from the first question: its first line, cut at a word near the limit. */
export function titleFrom(question: string): string {
  const line = question.trim().split('\n')[0].replace(/\s+/g, ' ');
  if (line.length <= 60) return line || UNTITLED;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

function dirOf(cluster: string): string {
  return path.join(CONVERSATIONS_DIR, assertClusterName(cluster));
}

function fileOf(cluster: string, id: string): string {
  if (!isConversationId(id)) throw new HttpError(400, 'Which conversation?');
  return path.join(dirOf(cluster), `${id}.json`);
}

async function save(record: ConversationRecord): Promise<void> {
  const file = fileOf(record.cluster, record.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const modeOf = (v: unknown): ConversationMode => (v === 'work' ? 'work' : 'discuss');

/** A file as a record, checked field by field. Anything that does not hold together is null, never thrown. */
export function parseRecord(raw: string, cluster: string, id: string): ConversationRecord | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || o.id !== id) return null;
  const session = (typeof o.session === 'object' && o.session !== null ? o.session : {}) as Record<string, unknown>;
  const turns = (Array.isArray(o.turns) ? o.turns : []).flatMap((t): ConversationTurn[] => {
    if (typeof t !== 'object' || t === null) return [];
    const r = t as Record<string, unknown>;
    if (typeof r.question !== 'string') return [];
    return [
      {
        at: str(r.at),
        question: r.question,
        answer: str(r.answer),
        sources: strings(r.sources),
        mode: modeOf(r.mode),
        model: strOrNull(r.model),
        answeredBy: strOrNull(r.answeredBy),
        wrote: strings(r.wrote),
        commit: strOrNull(r.commit),
        undoCommit: strOrNull(r.undoCommit),
        findings: (Array.isArray(r.findings) ? r.findings : []).flatMap((f) =>
          typeof f === 'object' && f !== null && typeof (f as Finding).detail === 'string'
            ? [{ severity: (f as Finding).severity === 'error' ? ('error' as const) : ('warning' as const), detail: (f as Finding).detail }]
            : [],
        ),
        error: strOrNull(r.error),
      },
    ];
  });
  return {
    id,
    cluster,
    title: str(o.title, UNTITLED).slice(0, TITLE_MAX) || UNTITLED,
    named: o.named === true,
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
    mode: modeOf(o.mode),
    model: strOrNull(o.model),
    session: { id: isConversationId(session.id) ? session.id : randomUUID(), started: session.started === true },
    turns,
  };
}

export async function readConversation(cluster: string, id: string): Promise<ConversationRecord | null> {
  const raw = await readIfPresent(fileOf(cluster, id));
  return raw === null ? null : parseRecord(raw, cluster, id);
}

export async function createConversation(cluster: string, now: Date = new Date()): Promise<ConversationRecord> {
  const at = now.toISOString();
  const record: ConversationRecord = {
    id: randomUUID(),
    cluster: assertClusterName(cluster),
    title: UNTITLED,
    named: false,
    createdAt: at,
    updatedAt: at,
    mode: 'discuss',
    model: null,
    session: { id: randomUUID(), started: false },
    turns: [],
  };
  await save(record);
  return record;
}

export async function listConversations(cluster: string): Promise<ConversationSummary[]> {
  const dir = dirOf(cluster);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: ConversationSummary[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !isConversationId(id)) continue;
    const record = await readConversation(cluster, id);
    if (!record) continue;
    out.push({
      id,
      title: record.title,
      updatedAt: record.updatedAt,
      turns: record.turns.length,
      wrote: record.turns.some((t) => t.commit && !t.undoCommit),
      mode: record.mode,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The newest conversation of a wiki, or null. */
export async function latestConversation(cluster: string): Promise<string | null> {
  return (await listConversations(cluster))[0]?.id ?? null;
}

/** A turn added, the conversation named by its first question unless a person named it. */
export async function appendTurn(record: ConversationRecord, turn: ConversationTurn): Promise<ConversationRecord> {
  record.turns.push(turn);
  record.mode = turn.mode;
  record.model = turn.model;
  record.updatedAt = turn.at || new Date().toISOString();
  if (!record.named && record.title === UNTITLED) record.title = titleFrom(turn.question);
  await save(record);
  return record;
}

/** Whatever else changed on the record (the session after a re-prime, an undo), kept. */
export async function saveConversation(record: ConversationRecord): Promise<void> {
  await save(record);
}

export async function renameConversation(cluster: string, id: string, title: string): Promise<ConversationRecord> {
  const record = await readConversation(cluster, id);
  if (!record) throw new HttpError(404, 'No such conversation');
  const clean = title.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX);
  if (!clean) throw new HttpError(400, 'Give it a name');
  record.title = clean;
  record.named = true;
  await save(record);
  return record;
}

export async function deleteConversation(cluster: string, id: string): Promise<boolean> {
  const file = fileOf(cluster, id);
  const there = await fs.stat(file).then(() => true, () => false);
  await fs.rm(file, { force: true });
  return there;
}

// ----------------------------------------------------------- one at a time

/**
 * A conversation answers one question at a time: the second of two at once
 * would resume a session the first is still writing to. In memory, like the
 * wiki's own lock, because there is one process.
 */
const globalForTalk = globalThis as typeof globalThis & { __brainTalking?: Set<string> };
const talking: Set<string> = (globalForTalk.__brainTalking ??= new Set());

export function beginTurn(id: string): void {
  if (talking.has(id)) throw new HttpError(409, 'This conversation is still answering. Wait for it, or stop it.');
  talking.add(id);
}

export function endTurn(id: string): void {
  talking.delete(id);
}
