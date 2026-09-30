import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, CLAUDE_CONFIG_DIR, CLAUDE_MODEL, PROMPTS_DIR, claudeArgs, claudeCommand, streamLogDir } from './config';
import { StreamParser, type AgentResult } from './claude-stream';
import type { Layout } from './layout';

/**
 * The process boundary between the app and the agent.
 *
 * There is no network protocol here. Node launches Claude Code as a child
 * process with the cluster as its working directory and reads its event stream.
 * What the agent may do is decided on the command line below, per task — not by
 * what the prompt asks of it, and not by anything found in the folder it works
 * in.
 *
 * The rules this file keeps, and why:
 *
 *  - `spawn` with an args array, never a shell. A shell would make any document
 *    title or question an injection vector.
 *  - The prompt goes in on stdin. Arguments are visible to every user of the
 *    machine in the process list, and a plan revision can be longer than
 *    Windows allows a command line to be.
 *  - No settings are loaded from anywhere (`--setting-sources ""`). The working
 *    directory is one the agent writes to, so a settings file or CLAUDE.md found
 *    there would be the agent configuring itself; and a developer's own
 *    ~/.claude must not reach a run either.
 *  - No shell and no web access for the agent, in any mode.
 *  - Never `--bare`: bare mode ignores the subscription login, which is the only
 *    credential this app is meant to run on.
 */

export type AgentMode = 'plan' | 'execute' | 'chat';

export interface AgentRun {
  /** Progress, one line at a time: what the agent is reading and writing, and what it says. */
  lines: AsyncGenerator<string>;
  /** Chat only: the answer as it is written. */
  tokens: AsyncGenerator<string>;
  /** Resolves when the process ends. Rejects if it could not start or ran out of time. */
  done: Promise<AgentResult>;
  /** The tail of stderr. Empty unless the binary complained. */
  stderrTail: () => string;
  kill: () => void;
}

/**
 * What each task may use.
 *
 * `tools` is the whole toolbox — anything not listed does not exist for the
 * run. `allow` is what may be done with it without asking, and in `dontAsk`
 * mode anything that would have to ask is refused. Reads inside the working
 * directory need no rule, which is why none is given: a bare `Read` rule would
 * open every file the process can reach.
 *
 * Paths starting with `/` are relative to the working directory.
 */
function profile(mode: AgentMode, layout: Layout): { tools: string[]; allow: string[] } {
  switch (mode) {
    // The working directory is a throwaway copy (see sandbox.ts). The one thing
    // the planner writes is its answer.
    case 'plan':
      return { tools: ['Read', 'Glob', 'Grep', 'Write'], allow: ['Edit(/plan.json)'] };
    // What may be written depends on where the wiki keeps its pages.
    case 'execute':
      return { tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'], allow: layout.writable };
    case 'chat':
      return { tools: ['Read', 'Glob', 'Grep'], allow: [] };
  }
}

/** Second layer under `--tools`: named so that a renamed flag or a new default cannot bring these back. */
const NEVER = ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'];

/**
 * Files that would let a run leave instructions for the next one, and files
 * that hold secrets. Deny rules win over allow rules.
 */
function denyRules(layout: Layout): string[] {
  return [
    ...NEVER,
    // Read at the start of every run as the rules for the wiki, and written by
    // a person. A run that could edit it would be writing the rules for the
    // next run. Named for both layouts, whichever this wiki has.
    'Edit(/SCHEMA.md)',
    `Edit(/${layout.rulesFile})`,
    // Sources are kept as they were given. The app puts them there; the agent reads them.
    `Edit(/${layout.rawDir}/**)`,
    // A folder that came here with a working copy of someone's mail has the
    // key to that mailbox in it.
    'Read(/**/_secrets/**)',
    'Edit(/staging/**)',
    'Edit(/CLAUDE.md)',
    'Edit(/**/CLAUDE.md)',
    'Edit(/AGENTS.md)',
    'Edit(/**/AGENTS.md)',
    'Edit(/.claude/**)',
    'Edit(/.mcp.json)',
    'Edit(/.git/**)',
    // Claude's own folder, where the login is kept: the default place, and the
    // one the app was told to use. Written as a pattern with `~` on purpose.
    // Asking Node for the home directory here made the build trace every file in
    // the builder's own ~/.claude and try to ship it with the app.
    'Read(~/.claude/**)',
    'Read(~/.claude.json)',
    ...(CLAUDE_CONFIG_DIR ? [`Read(${fromRoot(CLAUDE_CONFIG_DIR)}/**)`] : []),
    `Read(${fromRoot(path.join(APP_DIR, '.env'))})`,
    `Read(${fromRoot(path.join(APP_DIR, '.env.*'))})`,
    // The server's own environment is readable there by anything running as the same user.
    ...(process.platform === 'win32' ? [] : ['Read(//proc/**)']),
  ];
}

/** Permission rules mark a path from the filesystem root with a leading `//`. */
function fromRoot(absolute: string): string {
  const forward = absolute.split(path.sep).join('/');
  return forward.startsWith('/') ? `/${forward}` : `//${forward}`;
}

/** The generated part of the command line. Exported so the check scripts can hold it against the real binary. */
export function agentArgs(mode: AgentMode, layout: Layout): string[] {
  const { tools, allow } = profile(mode, layout);
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'dontAsk',
    '--tools', tools.join(','),
    ...(allow.length > 0 ? ['--allowedTools', ...allow] : []),
    '--disallowedTools', ...new Set(denyRules(layout)),
    '--append-system-prompt-file', path.join(PROMPTS_DIR, layout.prompt),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(CLAUDE_MODEL ? ['--model', CLAUDE_MODEL] : []),
  ];
}

/**
 * The agent's entire environment.
 *
 * Deliberately NOT a copy of process.env. The agent reads documents we did not
 * write, so every variable it can see is something an injected document could
 * ask it to repeat. It gets what the binary needs to start and find its login.
 * In particular it never gets an API key: if one were present the binary would
 * use it instead of the subscription.
 *
 * Do not widen this to `...process.env`.
 */
const PASS_THROUGH =
  process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERNAME']
    : ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

function narrowEnv(cwd: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.NODE_ENV = process.env.NODE_ENV ?? 'production';
  // Kept for the local fake, which has always found its wiki here.
  env.WIKI_PATH = cwd;
  if (CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  // The version that was tested is the version that runs.
  env.DISABLE_AUTOUPDATER = '1';
  // Auto memory is a note the agent leaves for its next run. See the rule about
  // CLAUDE.md above; this is the same thing by another route.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env as NodeJS.ProcessEnv;
}

/**
 * Everything that decides what a run may do: the command, its arguments and its
 * environment. One function, so that what the check scripts hold against the
 * real binary is exactly what the app runs.
 */
export function agentInvocation(
  mode: AgentMode,
  cwd: string,
  layout: Layout,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { command: claudeCommand(), args: [...claudeArgs(), ...agentArgs(mode, layout)], env: narrowEnv(cwd) };
}

/** See streamLogDir() in config.ts. A run is never failed because its record could not be kept. */
function openStreamLog(mode: AgentMode): WriteStream | null {
  const dir = streamLogDir();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const record = createWriteStream(path.join(dir, `${mode}-${stamp}-${randomUUID().slice(0, 8)}.jsonl`), { mode: 0o600 });
    record.on('error', (err) => console.error('[claude] could not keep the stream record', err));
    return record;
  } catch (err) {
    console.error('[claude] could not keep the stream record', err);
    return null;
  }
}

export function runClaude(opts: {
  mode: AgentMode;
  prompt: string;
  /** The wiki's folder, or for planning the throwaway copy of it. */
  cwd: string;
  /** How that wiki is laid out: it decides the rules the run is given and what it may write. */
  layout: Layout;
  timeoutMs?: number;
  usageFile?: string;
}): AgentRun {
  const lines = new Channel<string>();
  const tokens = new Channel<string>();
  const parser = new StreamParser(opts.cwd);
  const chat = opts.mode === 'chat';

  const { command, args, env } = agentInvocation(opts.mode, opts.cwd, opts.layout);
  const record = openStreamLog(opts.mode);
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env,
    // No shell. See above.
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let settle!: (result: AgentResult) => void;
  let fail!: (err: Error) => void;
  const done = new Promise<AgentResult>((res, rej) => {
    settle = res;
    fail = rej;
  });
  // A caller that is still reading `lines` has not attached a handler yet.
  done.catch(() => {});

  let result: AgentResult | null = null;
  let finished = false;
  const finish = (): void => {
    finished = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    record?.end();
    lines.close();
    tokens.close();
  };

  let killTimer: NodeJS.Timeout | null = null;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        child.kill('SIGKILL');
        finish();
        fail(new Error(`Claude exceeded ${opts.timeoutMs}ms and was stopped`));
      }, opts.timeoutMs)
    : null;

  child.on('error', (err) => {
    if (finished) return;
    finish();
    fail(new Error(`Could not start "${command}": ${err.message}`));
  });

  // stderr is diagnostics, not product output: it goes to the server log and is
  // never shown as if it were the agent's answer. The tail is kept so a failed
  // run can say why it failed. Bounded, because a crash loop produces a lot.
  const stderrChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    console.error('[claude]', d.trimEnd());
    stderrChunks.push(d);
    if (stderrChunks.length > 50) stderrChunks.shift();
  });
  const stderrTail = (): string => stderrChunks.join('').trim().split('\n').slice(-5).join(' ').slice(0, 500);

  const handle = (line: string): void => {
    for (const event of parser.push(line)) {
      switch (event.kind) {
        case 'init':
          if (event.leaked.length > 0) {
            console.error(`[claude] configuration the app did not ask for reached this run: ${event.leaked.join(', ')}`);
          }
          break;
        case 'delta':
          if (chat) tokens.push(event.text);
          break;
        case 'text':
          if (chat) {
            if (!event.streamed) tokens.push(event.text);
          } else {
            for (const part of event.text.split('\n')) if (part.trim()) lines.push(part.trim());
          }
          break;
        case 'tool':
          lines.push(event.line);
          break;
        case 'tool-failed':
          lines.push(`That did not work: ${event.detail}`);
          break;
        case 'retry':
          lines.push(`Waiting for Claude to respond (attempt ${event.attempt})`);
          break;
        case 'result':
          result = event.result;
          break;
      }
    }
  };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    record?.write(chunk);
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) handle(part);
  });

  child.on('close', (code) => {
    if (finished) return;
    if (buffer.trim()) handle(buffer);
    const final = conclude(result, code ?? 0, stderrTail());
    void writeUsage(opts.usageFile, final).finally(() => {
      finish();
      settle(final);
    });
  });

  // The process may exit before it has read its input — signed out, bad flag.
  // That is reported through the result, not as a broken pipe.
  child.stdin.on('error', () => {});
  child.stdin.end(opts.prompt);

  return {
    lines: lines.drain(),
    tokens: tokens.drain(),
    done,
    stderrTail,
    kill: () => {
      if (finished) return;
      child.kill('SIGINT');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    },
  };
}

/** The stream's verdict and the exit code, reconciled. A run is fine only when both say so. */
function conclude(fromStream: AgentResult | null, code: number, stderr: string): AgentResult {
  if (fromStream) {
    if (code !== 0 && fromStream.ok) {
      return { ...fromStream, ok: false, code, error: 'agent_error', errorDetail: stderr || `exit code ${code}` };
    }
    return { ...fromStream, code };
  }
  // No result line at all: the binary died, or it is not Claude Code.
  return {
    ok: false,
    code,
    sessionId: null,
    model: null,
    text: '',
    error: 'agent_error',
    errorDetail: stderr || (code === 0 ? 'the agent ended without reporting a result' : `exit code ${code}`),
    denials: [],
    usage: null,
    costUsd: null,
    turns: null,
    durationMs: null,
  };
}

async function writeUsage(file: string | undefined, result: AgentResult): Promise<void> {
  if (!file) return;
  const usage = result.usage;
  const record = {
    model: result.model,
    estimated_cost_usd: result.costUsd ?? 0,
    tokens: usage ? usage.inputTokens + usage.outputTokens : 0,
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_tokens: usage?.cacheReadTokens ?? 0,
    cache_creation_tokens: usage?.cacheCreationTokens ?? 0,
    turns: result.turns,
    duration_ms: result.durationMs,
    note: 'The cost is an estimate at API prices. On a subscription nothing is billed per run.',
  };
  try {
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    console.error('[claude] could not write the usage record', err);
  }
}

/**
 * Turn a failed run into something a reader can act on.
 *
 * "The agent stopped with exit code 1" sends someone looking at their document
 * when the actual fault is that the server's Claude is signed out. The two
 * failures a person can fix are named; anything else carries what the binary
 * said, because that is where the real reason lives.
 */
export function agentFailure(result: AgentResult, stderr: string): string {
  const denied =
    result.denials.length > 0
      ? ` It was refused: ${result.denials.map((d) => (d.target ? `${d.tool} on ${d.target}` : d.tool)).join('; ')}.`
      : '';
  switch (result.error) {
    case 'logged_out':
      return 'Claude is signed out on the server. Someone with access needs to open a terminal there, run `claude` and then `/login`. Your document is fine.';
    case 'limit':
      return `The Claude usage limit has been reached${result.errorDetail ? ` (${oneLine(result.errorDetail)})` : ''}. Try again once it resets. Your document is fine.`;
    case 'max_turns':
      return `The agent ran out of steps before it finished.${denied}`;
    default: {
      const because = oneLine(result.errorDetail ?? '') || oneLine(stderr);
      return `The agent stopped${result.code ? ` with exit code ${result.code}` : ''}${because ? ` — ${because}` : ''}.${denied}`;
    }
  }
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300);

/** Collect a full run into one string. Used for short, non-streaming calls. */
export async function runClaudeToString(opts: Parameters<typeof runClaude>[0]): Promise<string> {
  const run = runClaude(opts);
  // Both streams have to be read, or the one nobody reads holds the run's output in memory.
  const drainLines = (async () => {
    for await (const _ of run.lines) void _;
  })();
  let text = '';
  for await (const token of run.tokens) text += token;
  await drainLines;
  const result = await run.done;
  if (!result.ok) throw new Error(agentFailure(result, run.stderrTail()));
  return (text || result.text).trim();
}

/** One producer, one reader. Values wait in order until they are read. */
class Channel<T> {
  private readonly waiting: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.waiting.push(value);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.waiting.length > 0) yield this.waiting.shift() as T;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
