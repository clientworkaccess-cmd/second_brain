import path from 'node:path';

/**
 * Claude Code's `--output-format stream-json`, turned into what the app needs.
 *
 * Pure: text in, events out, no process and no clock. That is what lets the
 * check scripts run it against streams captured from the real binary
 * (scripts/fixtures/) instead of trusting that the local fake guessed the
 * format right.
 *
 * Shapes are recorded in docs/claude-contract.md. Two things there are easy to
 * get wrong and are handled below:
 *
 *  - A failed run can report `subtype: "success"`. When the binary is signed
 *    out, the result line says `is_error: true` and `subtype: "success"` in the
 *    same breath. `is_error` decides; `subtype` only refines.
 *  - Text arrives twice with --include-partial-messages: as deltas while it is
 *    written and again as a complete message. Deltas win when there were any.
 */

export type AgentErrorKind = 'logged_out' | 'limit' | 'max_turns' | 'agent_error';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentDenial {
  tool: string;
  /** What it was pointed at: a path relative to the working directory, or a short description. */
  target: string;
}

export interface AgentResult {
  ok: boolean;
  /** Process exit code. Filled in by the runner; null while only the stream is known. */
  code: number | null;
  sessionId: string | null;
  model: string | null;
  /** The final answer text. */
  text: string;
  error: AgentErrorKind | null;
  errorDetail: string | null;
  denials: AgentDenial[];
  usage: AgentUsage | null;
  /** Claude Code's own estimate at API prices. On a subscription nothing is billed per run. */
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
}

export type AgentEvent =
  | { kind: 'init'; sessionId: string | null; model: string | null; version: string | null; tools: string[]; leaked: string[] }
  /** A piece of answer text as it is written. */
  | { kind: 'delta'; text: string }
  /** A complete block of answer text. `streamed` means its deltas were already delivered. */
  | { kind: 'text'; text: string; streamed: boolean }
  /** The agent used a tool. `line` is fit to show to a person. */
  | { kind: 'tool'; name: string; line: string }
  | { kind: 'tool-failed'; detail: string }
  | { kind: 'retry'; attempt: number; error: string }
  | { kind: 'result'; result: AgentResult };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class StreamParser {
  private sessionId: string | null = null;
  private model: string | null = null;
  private sawDelta = false;
  private apiError: string | null = null;

  constructor(private readonly cwd: string) {}

  /** One line of stdout in, zero or more events out. Never throws. */
  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Not part of the protocol — a warning the binary printed, or an agent
      // that speaks plain text. Shown as it is rather than dropped.
      return [{ kind: 'text', text: trimmed, streamed: false }];
    }
    if (!isObject(event)) return [];

    // Subagent traffic carries the id of the tool call that spawned it. The app
    // allows no subagents, and would not want their chatter in an answer.
    if (event.parent_tool_use_id) return [];

    switch (event.type) {
      case 'system':
        return this.system(event);
      case 'stream_event':
        return this.partial(event);
      case 'assistant':
        return this.assistant(event);
      case 'user':
        return this.toolResults(event);
      case 'result':
        return [{ kind: 'result', result: this.result(event) }];
      default:
        return [];
    }
  }

  private system(event: Json): AgentEvent[] {
    if (event.subtype === 'init') {
      this.sessionId = str(event.session_id) || null;
      this.model = str(event.model) || null;
      return [
        {
          kind: 'init',
          sessionId: this.sessionId,
          model: this.model,
          version: str(event.claude_code_version) || null,
          tools: Array.isArray(event.tools) ? event.tools.map(String) : [],
          leaked: leakedConfiguration(event),
        },
      ];
    }
    if (event.subtype === 'api_retry') {
      const error = str(event.error) || 'unknown';
      this.apiError = error;
      return [{ kind: 'retry', attempt: num(event.attempt) ?? 1, error }];
    }
    return [];
  }

  private partial(event: Json): AgentEvent[] {
    const inner = isObject(event.event) ? event.event : null;
    if (!inner) return [];
    if (inner.type === 'message_start') this.sawDelta = false;
    const delta = isObject(inner.delta) ? inner.delta : null;
    if (inner.type !== 'content_block_delta' || !delta || delta.type !== 'text_delta') return [];
    const text = str(delta.text);
    if (!text) return [];
    this.sawDelta = true;
    return [{ kind: 'delta', text }];
  }

  private assistant(event: Json): AgentEvent[] {
    if (event.error) this.apiError = str(event.error);
    const message = isObject(event.message) ? event.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const out: AgentEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text') {
        const text = str(block.text);
        if (text.trim()) out.push({ kind: 'text', text, streamed: this.sawDelta });
      } else if (block.type === 'tool_use') {
        const name = str(block.name) || 'a tool';
        out.push({ kind: 'tool', name, line: describeTool(name, block.input, this.cwd) });
      }
    }
    this.sawDelta = false;
    return out;
  }

  private toolResults(event: Json): AgentEvent[] {
    const message = isObject(event.message) ? event.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const out: AgentEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result' || block.is_error !== true) continue;
      out.push({ kind: 'tool-failed', detail: flatten(block.content).slice(0, 300) });
    }
    return out;
  }

  private result(event: Json): AgentResult {
    const text = str(event.result);
    const failed = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
    const usage = isObject(event.usage) ? event.usage : null;
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    const error = failed ? classify(str(event.subtype), `${this.apiError ?? ''} ${str(event.terminal_reason)} ${text}`) : null;

    return {
      ok: !failed,
      code: null,
      sessionId: str(event.session_id) || this.sessionId,
      model: this.model,
      text,
      error,
      errorDetail: failed ? text.trim() || this.apiError || str(event.subtype) || null : null,
      denials: denials.filter(isObject).map((d) => ({
        tool: str(d.tool_name) || 'a tool',
        target: targetOf(d.tool_input, this.cwd),
      })),
      usage: usage
        ? {
            inputTokens: num(usage.input_tokens) ?? 0,
            outputTokens: num(usage.output_tokens) ?? 0,
            cacheReadTokens: num(usage.cache_read_input_tokens) ?? 0,
            cacheCreationTokens: num(usage.cache_creation_input_tokens) ?? 0,
          }
        : null,
      costUsd: num(event.total_cost_usd),
      turns: num(event.num_turns),
      durationMs: num(event.duration_ms),
    };
  }
}

/** Convenience for tests and scripts: a whole capture at once. */
export function parseStream(text: string, cwd: string): AgentEvent[] {
  const parser = new StreamParser(cwd);
  return text.split(/\r?\n/).flatMap((line) => parser.push(line));
}

/**
 * Sorts a failure into something the app can explain.
 *
 * Signed out and limit reached are checked first, by what the binary said —
 * they are the two failures a person can fix, and the binary reports both as an
 * ordinary-looking result.
 */
export function classify(subtype: string, said: string): AgentErrorKind {
  const hay = said.toLowerCase();
  if (/authentication_failed|not logged in|\/login|login expired|invalid api key|oauth token|unauthori[sz]ed/.test(hay)) {
    return 'logged_out';
  }
  if (/rate_limit|usage limit|limit reached|rate limit|too many requests|overloaded|account_on_hold|billing_error/.test(hay)) {
    return 'limit';
  }
  if (subtype === 'error_max_turns') return 'max_turns';
  return 'agent_error';
}

/** "Read" + {file_path: "/var/brain-data/ops/index.md"} -> "Reading index.md". */
export function describeTool(name: string, input: unknown, cwd: string): string {
  const args = isObject(input) ? input : {};
  switch (name) {
    case 'Read':
      return `Reading ${relative(args.file_path, cwd)}`;
    case 'Write':
      return `Writing ${relative(args.file_path, cwd)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Updating ${relative(args.file_path, cwd)}`;
    case 'Glob':
      return `Looking for ${str(args.pattern) || 'files'}`;
    case 'Grep':
      return `Searching for "${str(args.pattern).slice(0, 80)}"`;
    default:
      return `Using ${name}`;
  }
}

function targetOf(input: unknown, cwd: string): string {
  const args = isObject(input) ? input : {};
  if (typeof args.file_path === 'string') return relative(args.file_path, cwd);
  if (typeof args.command === 'string') return args.command.slice(0, 120);
  if (typeof args.url === 'string') return args.url.slice(0, 120);
  if (typeof args.pattern === 'string') return args.pattern.slice(0, 120);
  return '';
}

/** Inside the working directory: the path from it. Outside: the file name only, so no server layout leaks into the UI. */
function relative(file: unknown, cwd: string): string {
  if (typeof file !== 'string' || !file) return 'a file';
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(file);
  return rel.split(path.sep).join('/');
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObject(c) ? str(c.text) : String(c))).join(' ');
  return '';
}

/**
 * Anything in the session that the app did not put there. The command line asks
 * for no settings, no MCP servers, no skills and no plugins; if any show up
 * anyway, a personal configuration has reached the agent and the run is not the
 * one that was tested.
 */
function leakedConfiguration(init: Json): string[] {
  const leaked: string[] = [];
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => (isObject(v) ? str(v.name) : String(v))).filter(Boolean) : [];
  for (const server of names(init.mcp_servers)) leaked.push(`MCP server ${server}`);
  for (const skill of names(init.skills)) leaked.push(`skill ${skill}`);
  for (const plugin of names(init.plugins)) leaked.push(`plugin ${plugin}`);
  return leaked;
}
