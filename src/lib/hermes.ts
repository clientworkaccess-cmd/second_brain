import { spawn } from 'node:child_process';
import { HERMES_ARGS, HERMES_CMD, WIKI_ROOT } from './config';

/**
 * The process boundary between the dashboard and the agent.
 *
 * There is no network protocol here. Node launches Hermes as a child process,
 * hands it a WIKI_PATH it cannot reach outside of, and reads stdout. That env
 * var is the isolation boundary — structural, not a rule the agent is asked to
 * follow.
 *
 * `spawn` with an args array, never `exec`: exec goes through a shell, which
 * makes any document title or user question a shell-injection vector.
 */

export interface HermesRun {
  /** Yields whatever the agent writes, line by line, as it arrives. */
  lines: AsyncGenerator<string>;
  /** Resolves with the exit code once the process ends. */
  done: Promise<number>;
  /**
   * The tail of stderr. Empty unless the agent complained.
   *
   * Exists because "Hermes exited with code 2" is not a diagnosis. When the
   * dashboard passed a flag the binary did not have, the reason was sitting in
   * stderr on the VPS while the dashboard showed a generic failure and pointed
   * the reader at the document. The cause belongs on the screen with the error.
   */
  stderrTail: () => string;
  kill: () => void;
}

/**
 * The agent's entire environment.
 *
 * Deliberately NOT a copy of process.env. Hermes runs unattended with shell
 * access over documents we did not write, so every variable it can see is
 * something an injected PDF could read and exfiltrate. It gets what it needs to
 * run, the wiki path, and the model key — nothing else.
 *
 * Do not widen this to `...process.env`.
 */
function narrowEnv(clusterPath: string, wikiRoot: string = WIKI_ROOT): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    WIKI_PATH: clusterPath,
    WIKI_ROOT: wikiRoot,
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  };
  if (process.env.HERMES_API_KEY) env.HERMES_API_KEY = process.env.HERMES_API_KEY;
  return env as NodeJS.ProcessEnv;
}

export function runHermes(opts: {
  prompt: string;
  clusterPath: string;
  usageFile?: string;
  timeoutMs?: number;
  /**
   * Override the WIKI_ROOT the agent sees. Planning runs against a throwaway
   * copy of the cluster, and passing only `clusterPath` would leave WIKI_ROOT
   * pointing at the live tree — so anything resolving through the root rather
   * than WIKI_PATH would escape the sandbox. Both have to move together.
   */
  wikiRoot?: string;
}): HermesRun {
  /**
   * Only flags the real binary actually has.
   *
   * There is no arbitrary-args escape hatch here on purpose. One existed
   * briefly and was used to pass an invented `--plan-file`; Hermes rejected the
   * whole invocation with exit code 2, which surfaced in the UI as "Ingest
   * failed" with no hint that the cause was the command line rather than the
   * document. Anything the agent needs to be told belongs in the prompt, where
   * being wrong costs a bad answer instead of a dead process.
   */
  const args = [...HERMES_ARGS, '-z', opts.prompt, '--yolo'];
  if (opts.usageFile) args.push('--usage-file', opts.usageFile);

  const child = spawn(HERMES_CMD, args, {
    env: narrowEnv(opts.clusterPath, opts.wikiRoot),
    // No shell. See above.
    shell: false,
  });

  let settle: (code: number) => void;
  let fail: (err: Error) => void;
  const done = new Promise<number>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const timer = opts.timeoutMs
    ? setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`Hermes exceeded ${opts.timeoutMs}ms and was killed`));
      }, opts.timeoutMs)
    : null;

  child.on('error', (err) => {
    if (timer) clearTimeout(timer);
    fail(new Error(`Could not start "${HERMES_CMD}": ${err.message}`));
  });
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    settle(code ?? 0);
  });

  async function* lines(): AsyncGenerator<string> {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) yield line;
    }
    if (buffer.length) yield buffer;
  }

  // stderr is diagnostics, not product output: it goes to the server log and is
  // never streamed to the client as if it were the agent's answer. The tail is
  // kept so a failed run can say why it failed. Bounded, because a crash loop
  // can produce a lot of it.
  const stderrChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    console.error('[hermes]', d.trimEnd());
    stderrChunks.push(d);
    if (stderrChunks.length > 50) stderrChunks.shift();
  });

  return {
    lines: lines(),
    done,
    stderrTail: () => stderrChunks.join('').trim().split('\n').slice(-5).join(' ').slice(0, 500),
    kill: () => child.kill('SIGTERM'),
  };
}

/** Collect a full run into one string. Used for short, non-streaming calls. */
export async function runHermesToString(opts: Parameters<typeof runHermes>[0]): Promise<string> {
  const run = runHermes(opts);
  const out: string[] = [];
  for await (const line of run.lines) out.push(line);
  await run.done;
  return out.join('\n').trim();
}
