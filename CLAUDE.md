# Brain App — working notes for Claude

Next.js 15 wiki dashboard, one process, that runs Claude Code as a child process
on a Claude subscription. In-house tool for a small team. Built from the
team's earlier wiki dashboard, which ran the Hermes agent.

This file is for working on the code. It is not loaded by the agent the app
runs, which loads no settings or instruction files from anywhere.

## Commands

- `npm run dev` — dev server on 3000, against the stand-in agent.
- `npm run build` — production build. `postbuild` fails it if any file outside
  the checkout is traced into the bundle.
- `npm run check` — stream, auth, pipeline and lint checks, all against the
  stand-in. `npm run typecheck` — tsc.
- `npm run check:live` — starts the built server on a free port and drives it
  over HTTP. Needs a build. The only check that goes through the middleware.
- `npm run check:real` — the app's exact command line against the real binary.
  Needs `CLAUDE_CMD`; beyond part 1 it needs a login. `-- --capture` writes the
  stream fixtures.
- `npm run hash-password -- <email>` — prints the three sign-in env lines.

## Rules that are easy to break

- **No API key, ever.** Not in env files, not passed to the agent, not as a
  fallback. Never `--bare`, never `--dangerously-skip-permissions`.
  `check:pipeline` fails on any of them, and on any flag not listed in
  `docs/claude-contract.md`.
- **Nothing reads `process.env` except `src/lib/config.ts` and
  `src/lib/env-auth.ts`.** The second exists because the middleware imports it
  and must not pull in Node modules.
- **Settings that checks switch between runs are functions**, not constants:
  `claudeCommand()`, `claudeArgs()`, `streamLogDir()`. As constants they were
  read once at import and the test that switched them could not fail.
- **No `os.homedir()` and no absolute paths in `src/`.** The build's file tracer
  reads them as "ship the files there" and copied `~/.claude` next to the app.
- **The agent's environment is an allowlist** (`narrowEnv` in `claude.ts`). Do
  not widen it to `...process.env`.
- **The hash format has no `$` in it.** Next's env loader expands `$name` inside
  values, quoted or not.
- **The middleware matcher covers every path**, and `lib/gate.ts` is an
  allowlist. Route handlers do not re-check the session.
- **Redirects are built from the forwarded host, not from `request.url`.** Behind
  the proxy `request.url` says `localhost:3003`.
- **Paths from env files are resolved against the checkout** (`APP_DIR`), not
  the working directory. The production server changes into `.next/standalone`
  before any of our code runs.
- **Only the login, the favicon and `/_next/static/` are public.** The image
  optimizer is off (`images.unoptimized`) and behind the login; the app has no
  images.
- **Never commit real documents or a filled-in env file.**

## Where things are

`src/lib/claude.ts` builds the command and runs it; `claude-stream.ts` is the
pure parser. `jobs.ts` is the plan, approve, file pipeline with the per-cluster
lock; `sandbox.ts` makes the throwaway copy a plan runs in; `lint.ts` is the
check after filing; `git.ts` commits the cluster. `gate.ts`, `session.ts`,
`auth.ts` are sign-in. `prompts/llm-wiki.md` is what the agent is told about the
wiki. `scripts/fake-claude.mjs` is the stand-in; `scripts/fixtures/` holds
streams captured from the real binary.

## Working on Windows

Paths must be short: Claude Code refuses a working directory with a long path.
The real binary of an npm install is `…/node_modules/@anthropic-ai/claude-code/bin/claude.exe`;
the `claude.cmd` wrapper cannot be started without a shell. Line endings are LF
(`.gitattributes`).

## State

Stage 1 of the plan: parity with the old dashboard on Claude Code. Checked
against Claude Code 2.1.247 signed out. Everything that needs a login is listed
as not checked in `docs/claude-contract.md`. Not deployed.
