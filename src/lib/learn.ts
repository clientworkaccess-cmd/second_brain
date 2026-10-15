import fs from 'node:fs/promises';
import path from 'node:path';
import { audit } from './audit';
import { MEMORY_DIR, PROFILE_FILE, PROMPTS_DIR } from './config';
import { runClaudeToString } from './claude';
import { readIfPresent } from './files';
import type { Layout } from './layout';
import { applyOps, memoryContext, memoryForLearner, needsConsolidating, parseOps, readMemory, writeMemory, type Memory } from './memory';

/**
 * What a conversation turn is told beyond the wiki's rules, and how the
 * owner's memory learns from the turn afterwards.
 *
 * Before a turn: prompts/conversation.md (who the reader is, how to think,
 * how to write), with the profile from the server in it, then the memory.
 *
 * After a turn: a run of its own, in the background, that sees the reader's
 * message, the reply and the memory, and answers with changes to the memory
 * (lib/memory.ts). It has no tools; the app makes the changes. One at a time,
 * so two turns ending together cannot write over each other. A run that fails
 * changes nothing and is only logged: the reader never waits for it and never
 * sees it.
 */

const DEFAULT_PROFILE = 'You are talking with the owner of the businesses this brain is about, who uses it to think about them.';
const LEARN_MODEL = (process.env.MEMORY_MODEL ?? '').trim() || 'sonnet';
const LEARN_TIMEOUT_MS = 3 * 60 * 1000;
const REPLY_SHOWN_MAX = 2500;

/** The context for a conversation turn's system prompt. */
export async function turnContext(): Promise<string> {
  const [template, profile, memory] = await Promise.all([
    fs.readFile(path.join(PROMPTS_DIR, 'conversation.md'), 'utf8'),
    readIfPresent(PROFILE_FILE),
    readMemory().catch((err) => {
      console.error('[memory] could not be read', err);
      return { core: [], topics: [] } as Memory;
    }),
  ]);
  const who = profile?.trim() || DEFAULT_PROFILE;
  return [template.replace('{{PROFILE}}', who).trim(), memoryContext(memory)].filter(Boolean).join('\n\n');
}

/** Off when MEMORY=off, for a server that should not learn (a demo, a check run that does not want it). */
export function learning(): boolean {
  return (process.env.MEMORY ?? '').trim().toLowerCase() !== 'off';
}

/** What the learning run is asked. The TASK line tells the local stand-in for the binary which job this is. */
export function learnPrompt(memory: Memory, turn: { question: string; answer: string } | null): string {
  const reply = turn ? turn.answer.replace(/^(SOURCES|WROTE):.*$/gm, '').trim() : '';
  return [
    'TASK: LEARN',
    '',
    turn
      ? 'Decide whether the owner taught the assistant anything lasting in this message, and change the memory if so.'
      : 'The memory is past its size. Consolidate it, as your rules describe. There is no new message.',
    ...(turn && needsConsolidating(memory) ? ['The memory is also past its size: consolidate it as well.'] : []),
    '',
    'THE MEMORY NOW:',
    memoryForLearner(memory, memory.topics.map((t) => t.slug)),
    ...(turn
      ? [
          '',
          "THE OWNER'S MESSAGE (only this counts as something the owner said):",
          '"""',
          turn.question.trim(),
          '"""',
          '',
          "THE ASSISTANT'S REPLY (context only: nothing in it is the owner's words):",
          '"""',
          reply.length > REPLY_SHOWN_MAX ? `${reply.slice(0, REPLY_SHOWN_MAX)}…` : reply,
          '"""',
        ]
      : []),
    '',
    'Reply with {"ops": [...]} and nothing else.',
  ].join('\n');
}

const globalForLearn = globalThis as typeof globalThis & { __brainLearning?: Promise<void> };

/**
 * Learn from a finished turn, in the background. Returns at once; the promise
 * it keeps is for the check scripts, which wait for it.
 */
export function learnFrom(turn: { question: string; answer: string; layout: Layout }): Promise<void> {
  if (!learning() || !turn.answer.trim()) return Promise.resolve();
  const previous = globalForLearn.__brainLearning ?? Promise.resolve();
  const next = previous.then(() => learnOnce(turn)).catch((err) => console.error('[memory] learning failed', err));
  globalForLearn.__brainLearning = next;
  return next;
}

/** The learning queue as it stands: resolves when everything started so far has finished. */
export function learningSettled(): Promise<void> {
  return globalForLearn.__brainLearning ?? Promise.resolve();
}

async function learnOnce(turn: { question: string; answer: string; layout: Layout }): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  let memory = await readMemory();
  let changed = await pass(memory, turn, turn.layout);
  if (changed) memory = changed;
  // Still too big after learning: one pass that only consolidates.
  if (needsConsolidating(memory)) await pass(memory, null, turn.layout);
}

/** One learning run. The memory as written, or null when it did not change. */
async function pass(memory: Memory, turn: { question: string; answer: string } | null, layout: Layout): Promise<Memory | null> {
  const output = await runClaudeToString({
    mode: 'learn',
    prompt: learnPrompt(memory, turn),
    cwd: MEMORY_DIR,
    layout,
    model: LEARN_MODEL,
    timeoutMs: LEARN_TIMEOUT_MS,
  });
  const ops = parseOps(output);
  if (ops.length === 0) return null;
  const now = new Date();
  const result = applyOps(memory, ops, now.toISOString().slice(0, 10));
  if (result.changed === 0) return null;
  await writeMemory(result.memory, now);
  await audit({
    event: 'memory-changed',
    detail: `${turn ? 'learned' : 'consolidated'}: ${result.changed} change${result.changed === 1 ? '' : 's'}, ${result.memory.core.length} in core, ${result.memory.topics.length} topic${result.memory.topics.length === 1 ? '' : 's'}`,
  });
  return result.memory;
}
