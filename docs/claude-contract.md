# The Claude Code contract

What the app assumes about the `claude` binary, what has been checked against
the real thing, and what has not been yet.

The app never talks to a model directly. It starts Claude Code as a child
process, writes the task to its standard input and reads its event stream. The
whole of that boundary is two files: `src/lib/claude.ts` builds the command and
runs it, `src/lib/claude-stream.ts` reads what comes back.

## Version

Checked against **Claude Code 2.1.247** on 2026-09-28.

The server runs one pinned version with the auto-updater off. See
[Upgrading](#upgrading) before changing it.

## The command

The task goes in on standard input, never as an argument. Arguments are visible
to every user of the machine in the process list, and a plan revision can be
longer than Windows allows a command line to be.

```bash
claude -p \
  --output-format stream-json --verbose --include-partial-messages \
  --permission-mode dontAsk \
  --tools <tools for the task> \
  --allowedTools <allow rules for the task> \
  --disallowedTools <deny rules> \
  --append-system-prompt-file <app>/prompts/<the wiki's layout>.md \
  --setting-sources "" \
  --strict-mcp-config \
  --disable-slash-commands \
  --no-session-persistence \
  [--model $CLAUDE_MODEL]
```

| Part | Why it is there |
|---|---|
| `-p` | One task, no terminal interface |
| `--output-format stream-json --verbose` | Events as JSON lines. The binary requires `--verbose` with this format |
| `--include-partial-messages` | Chat answers arrive as they are written |
| `--permission-mode dontAsk` | Anything that would need a person to approve it is refused instead |
| `--tools` | The whole toolbox for the run. A tool not named here does not exist for it |
| `--allowedTools` | What may be done without approval, which in `dontAsk` means what may be done at all |
| `--disallowedTools` | Second layer. Deny rules win over allow rules |
| `--append-system-prompt-file` | The wiki rules, added to Claude Code's own instructions: `prompts/llm-wiki.md` for a cluster, `prompts/brain-wiki.md` for a brain (see the README, "Two layouts") |
| `--no-session-persistence` | Planning and filing keep nothing of a run. Chat is the exception below |
| `--session-id <uuid>`, `--resume <uuid>` | Chat only. The first question of a conversation starts a session under an id the app made; every later question resumes it, so the agent remembers what was asked. The session lives in Claude's own folder, and is the one thing a run keeps |
| `--setting-sources ""` | No settings and no `CLAUDE.md` are loaded from anywhere: not from the working directory, which the agent writes to, and not from anyone's home. A brain keeps its rules in a `CLAUDE.md` at the top of its folder; it reaches the agent because the prompt says to read it, never as settings |
| `--strict-mcp-config` | No MCP servers except ones named on the command line, and none are |
| `--disable-slash-commands` | No skills or commands |
| `--no-session-persistence` | The run is not stored. Nothing is resumed in this stage, and a stored session is a copy of document text |

Never on the command line:

| Flag | Why not |
|---|---|
| `--bare` | It ignores the subscription login, which is the only credential this app runs on |
| `--dangerously-skip-permissions`, `bypassPermissions` | They switch off everything in this document |

`npm run check:pipeline` fails if any flag outside the list above appears in
`src/lib/claude.ts`, or if any of the three in the second table does.

## Tools and rules per task

| Task | Working directory | `--tools` | `--allowedTools` |
|---|---|---|---|
| plan | a throwaway copy of the wiki | `Read,Glob,Grep,Write` | `Edit(/plan.json)` |
| execute | the wiki's folder | `Read,Glob,Grep,Write,Edit` | `Edit(/**)` in a cluster; `Edit(/wiki/**)` in a brain, whose pages are in `wiki/` |
| chat | the wiki's folder | `Read,Glob,Grep` | none |

There is no allow rule for `Read`. Reading inside the working directory needs
none, and a bare `Read` rule would open every file the process can reach.

Denied in every task:

| Rule | What it protects |
|---|---|
| `Bash`, `WebFetch`, `WebSearch`, `Agent`, `Task`, `NotebookEdit` | No shell, no network, no subagents, even if a later version adds them to a default |
| `Edit(/SCHEMA.md)`, and in a brain `Edit(/CLAUDE.md)` | The rules for the wiki, which every run reads first. Written by a person |
| `Edit(/raw/**)` | Sources stay as they were given. The app puts them there |
| `Edit(/staging/**)`, `Read(/**/_secrets/**)` | A brain may have come with a working copy of a mailbox beside the wiki. It is not written, and its key is not read |
| `Edit(/CLAUDE.md)`, `Edit(/**/CLAUDE.md)`, `Edit(/AGENTS.md)`, `Edit(/**/AGENTS.md)` | A run cannot leave instructions for the next one |
| `Edit(/.claude/**)`, `Edit(/.mcp.json)` | A run cannot configure the next one |
| `Edit(/.git/**)` | The restore points stay intact |
| `Read(//<claude config dir>/**)` | The login |
| `Read(//<app>/.env)`, `Read(//<app>/.env.*)` | The sign-in hash and the session secret |
| `Read(//proc/**)` on Linux | The server's environment, readable there by any process of the same user |

In a rule, a path that starts with `/` is relative to the working directory and
a path that starts with `//` is absolute. An `Edit` rule covers every tool that
changes files, `Write` included.

## Environment

The agent does not inherit the server's environment. It is given:

| Variable | Value |
|---|---|
| `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`, proxy settings | passed through when set |
| on Windows instead | `PATH`, `PATHEXT`, `SystemRoot`, `COMSPEC`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` and the like |
| `CLAUDE_CONFIG_DIR` | where the login is, when set |
| `DISABLE_AUTOUPDATER` | `1` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1`. Auto memory is a note left for the next run |
| `WIKI_PATH` | the working directory. Only the local stand-in reads it |
| `NODE_ENV` | as the server's |

It is never given `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. If one were
present the binary would use it in place of the subscription. It is never given
`AUTH_PASSWORD_HASH` or `SESSION_SECRET`.

## Events the app reads

One JSON object per line. Lines that are not JSON are shown as text. Events with
a `parent_tool_use_id` belong to a subagent and are ignored.

| Event | Fields used | Becomes |
|---|---|---|
| `system` / `init` | `session_id`, `model`, `claude_code_version`, `tools`, `mcp_servers`, `skills`, `plugins` | The start of a run. Any MCP server, skill or plugin listed is logged as configuration that should not be there |
| `system` / `api_retry` | `attempt`, `error` | "Waiting for Claude to respond" |
| `stream_event` | `event.type`, `event.delta.text` for `text_delta` | A piece of the chat answer |
| `assistant` | `message.content[]` of type `text` or `tool_use`; `error` | Text, or a progress line such as "Reading index.md" |
| `user` | `message.content[]` of type `tool_result` with `is_error` | "That did not work" |
| `result` | `is_error`, `subtype`, `result`, `permission_denials`, `usage`, `total_cost_usd`, `num_turns`, `duration_ms`, `terminal_reason` | The outcome |

Two things that are easy to get wrong:

1. **A failed run can call itself a success.** Signed out, the binary prints
   `"is_error": true` and `"subtype": "success"` on the same line and exits
   with code 1. `is_error` decides. The exit code is checked as well, and a run
   is fine only when both say so.
2. **Text arrives twice.** With partial messages on, an answer comes as deltas
   and then again as one complete message. The complete one is dropped when its
   deltas were delivered.

### Signed out

Captured from the real binary in `scripts/fixtures/stream-logged-out.jsonl`:

- `assistant` with `"error": "authentication_failed"`, model `<synthetic>`, and
  the text `Not logged in · Please run /login`
- `result` with `is_error: true`, `subtype: "success"`,
  `terminal_reason: "api_error"`
- exit code 1

The app turns this into: "Claude is signed out on the server…".

## What has been checked, and what has not

| Claim | State |
|---|---|
| The binary accepts every flag and rule the app generates, in all three tasks | **Checked**, signed out, 2.1.247, `npm run check:real` |
| A run starts with exactly the tools asked for | **Checked**, same run |
| No settings, MCP servers, skills, plugins or slash commands are loaded, on a PC that has all of them configured | **Checked**, same run |
| Permission mode is `dontAsk` and no API key is in use | **Checked**, same run |
| The shape of a signed-out run | **Checked**, captured as a fixture |
| The shape of a run that hit the usage limit | Not checked. Recognised by wording (`usage limit`, `rate_limit`, and similar). The stand-in's version is modelled on the signed-out shape |
| The shape of ordinary plan, filing and chat runs | Not checked. Needs a login. The parser is written from the documentation |
| The agent is refused: shell, writing outside the wiki, `CLAUDE.md`, `.claude/`, `.mcp.json`, `SCHEMA.md`, `raw/` | Not checked. Needs a login |
| Planning can write `plan.json` and nothing else | Not checked. Needs a login |
| Claude's own folder and the app's env files cannot be read | Not checked. Needs a login |
| Whether files outside the wiki that no rule names can be read | Not known. Needs a login. Until it is known, assume they can, and rely on what the unix user is allowed to open |
| That `/path` in a rule given on the command line is relative to the working directory | Not checked. From the documentation |

Everything marked "needs a login" is one command once the binary is signed in:

```bash
CLAUDE_CMD=/path/to/claude npm run check:real -- --capture
```

It asks the agent to do each thing it must not be able to do, looks at the disk
afterwards, and keeps the raw streams of one plan, one filing and one question
as `scripts/fixtures/stream-{plan,execute,chat}.jsonl`. `npm run check:stream`
then tests the parser against them. Read the three files before committing
them; they are made from a made-up document, but they hold whatever the binary
printed.

Update the table above when that has been run.

## Where the wiki rules come from

`prompts/llm-wiki.md` follows the conventions of the Hermes `llm-wiki` skill,
version 2.1.0, which the dashboard ran on before: the three layers, orientation
before any work, what earns a page, the block at the top of every page,
provenance markers, how disagreement between sources is recorded, and the
formats of `index.md` and `log.md`.

Left out on purpose:

| The skill | Here |
|---|---|
| Fetches sources from the web and saves them under `raw/` | The app receives documents, converts them and puts them in `raw/`. The agent has no web access |
| Files a good answer back as a page, and logs every question | A question cannot write. The agent says when an answer is worth keeping |
| Adds new tags to `SCHEMA.md` before using them | The agent cannot change `SCHEMA.md`. It reuses tags and reports a missing one |
| Runs its own lint with a script | The app checks the disk after every filing |
| Asks before touching ten or more pages | A person approves the plan before anything is written |
| Sets up Obsidian sync from a shell | No shell |

## The local stand-in

`scripts/fake-claude.mjs` speaks the same protocol and is what `npm run dev`
and `npm run check` use. It needs no login and uses nothing.

It enforces no permissions, on purpose. With `--skip sandbox` it writes where a
planner must not, which is how the throwaway copy is shown to hold against an
agent that misbehaves. Whether the real binary refuses what it should is a
question only the real binary can answer, which is what `check:real` is for.

| Switch, through `CLAUDE_ARGS` | Effect |
|---|---|
| `--skip index` | leaves `index.md` alone |
| `--skip log` | leaves `log.md` alone |
| `--skip sandbox` | writes pages during planning |
| `--touch schema` | changes `SCHEMA.md` while filing |
| `--touch source` | changes the source document while filing |
| `--fail auth` | ends the way the binary does when signed out |
| `--fail limit` | ends with a usage-limit message |

## Keeping a record of a run

Set `CLAUDE_STREAM_LOG` to a folder and every run's raw stream is kept there,
one file per run. It is for finding out why a run went wrong. The files hold
everything the agent read and wrote, document text included, so the setting
stays off in normal use and the folder is never inside the wiki.

## Upgrading

1. Install the new version beside the old one, or on a dev machine.
2. `CLAUDE_CMD=<new binary> npm run check:real -- --capture`
3. `npm run check`
4. Read the difference in the three fixture files. A field the parser uses that
   has changed name shows up there.
5. Put the new version number at the top of this file and on the server.

Claude Code has announced that the behaviour of `-p` will move towards what
`--bare` does today. When that happens the flags above need to be looked at
again before upgrading, the login in particular.
