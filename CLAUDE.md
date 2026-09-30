# Second Brain (web) — working notes for Claude

Next.js 15 wiki dashboard, one process, that runs Claude Code as a child process
on a Claude subscription. In-house tool for a small team. Built from the
team's earlier wiki dashboard, which ran the Hermes agent.

The product is called Second Brain and is the web side of the desktop app of
that name. The package, the service and the server folders are `brain-app`.

This file is for working on the code. It is not loaded by the agent the app
runs, which loads no settings or instruction files from anywhere.

## Commands

- `npm run dev` — dev server on 3000, against the stand-in agent. It compiles
  pages on demand; a sign-in can hang on the first visit. That is the dev
  server, not the app.
- `npm run serve` — the built app on 3100 with `.env.local`. Use this to judge
  behaviour, and for any walk-through in a browser.
- `npm run build` — production build. `postbuild` fails it if any file outside
  the checkout is traced into the bundle.
- `npm run check` — stream, auth, pipeline, lint, page, layout, facet,
  design and asset checks, all against the stand-in. `npm run typecheck` — tsc.
- `npm run check:live` — starts the built server on a free port and drives it
  over HTTP. Needs a build. The only check that goes through the middleware.
- `npm run check:real` — the app's exact command line against the real binary.
  Needs `CLAUDE_CMD`; beyond part 1 it needs a login. `-- --capture` writes the
  stream fixtures.
- `npm run hash-password -- <email>` — prints the three sign-in env lines.
  `npm run totp-secret` — prints the second factor and its setup key.

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
  allowlist. Route handlers do not re-check the session. Whether a session is
  still wanted (the epoch, the revoked ids) the middleware learns from
  `/api/auth/state` over loopback and keeps for five seconds; it cannot read
  a file where it runs.
- **Redirects are built from the forwarded host, not from `request.url`.** Behind
  the proxy `request.url` says `localhost:3003`.
- **Paths from env files are resolved against the checkout** (`APP_DIR`), not
  the working directory. The production server changes into `.next/standalone`
  before any of our code runs.
- **Only the login, the favicon, `/api/auth/state` and `/_next/static/` are
  public.** The image optimizer is off (`images.unoptimized`) and behind the
  login; the app has no images.
- **Every route that changes something writes to the trail** (`audit()` in
  `src/lib/audit.ts`): a new route that creates, files, saves or ends something
  gets a line too. Never a password, a code, a token or a page's text.
- **The block at the top of a page is read in `src/lib/frontmatter.ts` and
  nowhere else**, as YAML only. Never call the parser directly: it reads other
  formats when a block names one, and a page is data.
- **Only images are served from a wiki, and only from inside it**
  (`src/lib/assets.ts`): by extension, never a page's text, never a folder
  whose name starts with `.` or `_`. `check:assets` guards it. A remote image
  in a page is not shown at all.
- **Never commit real documents or a filled-in env file.**

## The interface

Read `DESIGN.md` before touching anything visible. The frame, tree, tabs,
status bar, reading view and graph chrome in `src/app/globals.css` are the
desktop app's own CSS with its class names, and the tokens in `src/app/theme.css`
are its tokens. Keep them in step with the desktop app's
`src/renderer/src/styles/`. Tailwind's palette is switched off; colours are the
tokens only. A class name of ours must not be a Tailwind utility (`outline`,
`inline`, `hidden`): `npm run check:design` looks for that.

A layout renders `<Frame>`. A page renders `<Center>` and, beside it, a
`<RightSidebar>` if it has one. Which sidebars are open and the theme live as
attributes on `<html>`, set before the first paint by the script in
`src/app/layout.tsx`, not in React state.

## Two layouts

A wiki is a cluster (this app made it: `SCHEMA.md`, pages beside it, links by
name) or a brain (kept by hand before: `CLAUDE.md`, pages in `wiki/`, a page
per source, links by file name). `src/lib/layout.ts` is the one place that
knows the difference; it is read from the folder (`wiki/index.md` makes a
brain), never recorded. Nothing else may know a folder name by heart: ask the
layout, or the listing from `lib/wiki.ts`. The stand-in tells the two apart
the same way. `scripts/gen-brain.mjs` makes a brain out of nothing for the
checks; a real one is never used in a check.

`lib/facets.ts` is the facets: read from the wiki's own registry page and
rules file on every scan, never kept here; `pageProblems` says what a block
gets wrong, and is what the check after filing and the page view both show.

`lib/wiki.ts` reads a wiki once and keeps it in memory, on `globalThis` like
the jobs. It looks at the folders again on every call, which is cheap, and
reads only files whose size or time changed. Anything that compares before
with after asks with `{ fresh: true }`.

## The editor

`src/editor/` is the desktop app's editor (`src/renderer/src/editor/` there).
`livePreview.ts`, `wikilinkDecorations.ts`, `frontmatterParser.ts`,
`theme.ts` and `format.ts` are that app's files as they are, in its style,
and are to be kept in step with it rather than edited here. `extensions.ts`,
`links.ts` and `wikilinkCompletion.ts` are this app's, because the editor
here is handed its link targets and hooks by the page instead of reading a
store. `src/lib/pages.ts` is the one place the app writes a page: a `.md`
file among the pages and nothing else, refused when the file moved on since
it was read. `src/lib/assetPaths.ts` is how `![[photo.png]]` finds its file
(pure; the reading view, the editor and the server share it), `src/lib/assets.ts`
lists, reads and adds images, `GET/POST /api/asset` serves and takes them,
and `src/editor/imagePaste.ts` turns a paste or a drop into an upload and an
embed.

## The graph

`src/graph/webglGraph.ts` is the desktop app's engine as it is, and
`src/graph/data.ts` the parts of its `core/graph.ts` the engine draws from
(hues, area order, anchors). Keep both in step with the desktop app.
`src/components/GraphView.tsx` is this app's: it turns `lib/graph.ts` into
what the engine takes, and owns the header and the legend. Nothing about the
graph is checked from Node; the engine needs WebGL. Look at it in the browser
on a generated brain of 350 pages.

## Where things are

`src/lib/claude.ts` builds the command and runs it, by layout, and for a
question in a conversation with the session it keeps; `claude-stream.ts` is
the pure parser. `settings.ts` is what a person decided per wiki, in
`.dashboard/settings/`, today whether a filing waits for approval. `jobs.ts` is the plan, approve, file pipeline with the per-cluster
lock, the automatic path when a wiki files at once, and the undo; `sandbox.ts` makes the throwaway copy a plan runs in; `lint.ts` is the
check after filing and the whole-wiki check (`checkWiki`); `git.ts` commits the cluster. `gate.ts`, `session.ts`,
`auth.ts` are sign-in; `totp.ts` is the second factor, `sessions.ts` what is kept about sessions (`.dashboard/auth.json`: open, revoked, the epoch), `audit.ts` the trail (`.dashboard/audit.log`). `prompts/llm-wiki.md` and `prompts/brain-wiki.md` are
what the agent is told about a cluster and about a brain. `scripts/fake-claude.mjs` is the stand-in; `scripts/fixtures/` holds
streams captured from the real binary.

## Working on Windows

Paths must be short: Claude Code refuses a working directory with a long path.
The real binary of an npm install is `…/node_modules/@anthropic-ai/claude-code/bin/claude.exe`;
the `claude.cmd` wrapper cannot be started without a shell. Line endings are LF
(`.gitattributes`).

## State

Stage 1 of the plan: parity with the old dashboard on Claude Code. Checked
against Claude Code 2.1.247 signed out. Everything that needs a login is listed
as not checked in `docs/claude-contract.md`. Deployed by hand on the team's
server; the deploy workflow is still on manual trigger.

The interface follows the desktop app since the `second-brain-ui` change: same
tokens, same frame, plus search, backlinks, outline and page properties. Since
`wiki-layout` a wiki in the brain layout can be brought in as it is, and since
`facets` its facets are read, checked, filtered and drawn.
