# Brain App

The team's wiki with an agent behind it. Upload a document, read what the agent
proposes to file, approve it, and the pages are written. Ask a question and get
an answer with the pages it came from.

Next.js, one process. The agent is Claude Code, started as a child process and
signed in with the team's Claude subscription. There is no API key anywhere.

**Where this stands.** Stage 1 of 3: everything the older dashboard did, on
Claude Code instead of Hermes. The real wiki's structure (Stage 2) and the
Second Brain editor and graph (Stage 3) are not in here yet.

Visual system: [`Desing.md`](Desing.md). What the app assumes about the Claude
binary, and what has been checked: [`docs/claude-contract.md`](docs/claude-contract.md).

---

## Run it locally

No Claude login, no usage, no real documents.

```bash
npm install
cp .env.example .env.local
npm run hash-password -- you@example.com
npm run dev
```

`hash-password` asks for a password and prints three lines. Put them in
`.env.local` in place of the three empty ones. Sign-in stays closed until all
three are set; there is no built-in login.

`.env.example` points `CLAUDE_CMD` at `scripts/fake-claude.mjs`, a stand-in that
speaks the same protocol as the real binary, writes plausible pages and streams
a plausible answer. The whole UI works against it.

## Checks

| Command | What it holds the app to |
|---|---|
| `npm run check` | The four below, in order |
| `npm run check:stream` | The stream parser, against streams captured from the real binary and against the stand-in |
| `npm run check:auth` | What gets through without a session, what counts as a session, the password, the throttle |
| `npm run check:pipeline` | Plan, approve, reject, revise, a stale plan, a signed-out agent, and a planner that misbehaves |
| `npm run check:lint` | The check that runs after every filing |
| `npm run check:live` | The built app, started the way the server starts it and used over HTTP: sign-in, redirects, one document from upload to filed page, chat, a signed-out agent. Needs `npm run build` first |
| `npm run check:real` | The app's exact command line against the real `claude`. Not part of `check`: it needs the binary |
| `npm run typecheck` | TypeScript |

`check:auth` also tests a running server when `BASE_URL` is set.

The build itself is checked too. It fails if it would ship any file from
outside the checkout, which is how a copy of the builder's own Claude folder
once nearly ended up beside the app.

## The agent

| Task | It may use | It may write |
|---|---|---|
| Plan | read, search, write | its plan, in a throwaway copy of the cluster |
| File | read, search, write, edit | inside the cluster |
| Answer | read, search | nothing |

In every task it has no shell and no web access, loads no settings from
anywhere, and is refused `SCHEMA.md`, `raw/`, `CLAUDE.md`, `AGENTS.md`,
`.claude/`, `.mcp.json` and `.git/`. The wiki rules it follows are in
[`prompts/llm-wiki.md`](prompts/llm-wiki.md). They follow the conventions of the
Hermes `llm-wiki` skill the dashboard ran on before.

After every filing the app checks what was written, flags anything that should
not be there, and commits the cluster so there is a restore point.

---

## First deploy, by hand

Nothing here has been run on the VPS yet. Do it by hand once, in this order,
and only then turn the workflow on.

The older dashboard on port 3002 is not touched by any of this. Look at it
before and after.

**1. A user and its folders**

```bash
sudo useradd --create-home --shell /bin/bash brain
sudo install -d -o brain -g brain -m 750 /var/brain-data /var/lib/brain-app /var/lib/brain-app/claude /var/lib/brain-app/home
```

**2. The app, owned by root**

```bash
sudo git clone <repo> /opt/brain-app
cd /opt/brain-app && sudo npm ci --include=dev
sudo install -d -o brain -g brain /opt/brain-app/.libcheck
```

**3. Claude Code for that user, at the version that was tested**

```bash
sudo -u brain -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash -s 2.1.247'
```

**4. Sign in, once**

```bash
sudo -u brain env HOME=/var/lib/brain-app/home CLAUDE_CONFIG_DIR=/var/lib/brain-app/claude /home/brain/.local/bin/claude
```

Type `/login`, open the link it prints in a browser, finish there, then `/exit`.

**5. The env file**

```bash
sudo cp /opt/brain-app/.env.example /opt/brain-app/.env
sudo npm --prefix /opt/brain-app run hash-password -- you@example.com
sudoedit /opt/brain-app/.env
sudo chown root:root /opt/brain-app/.env && sudo chmod 600 /opt/brain-app/.env
```

In `.env`, besides the three sign-in lines:

```bash
WIKI_ROOT=/var/brain-data
CLAUDE_CMD=/home/brain/.local/bin/claude
CLAUDE_ARGS=
CLAUDE_CONFIG_DIR=/var/lib/brain-app/claude
```

**6. Ask the real binary, as the real user**

```bash
cd /opt/brain-app
sudo -u brain env HOME=/var/lib/brain-app/home CLAUDE_CONFIG_DIR=/var/lib/brain-app/claude \
  CLAUDE_CMD=/home/brain/.local/bin/claude npm run check:real
```

This is the step that matters most. It shows that the agent is refused what it
should be refused, on this machine, as this user. Do not go on if it fails.

**7. The service and the route**

```bash
sudo cp /opt/brain-app/deploy/brain-app.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable brain-app
sudo /opt/brain-app/deploy/deploy.sh
```

Put the domain in `deploy/traefik-dynamic.yml` and copy it into Traefik's
file-provider directory.

## Updating

```bash
ssh <admin>@vps 'sudo /opt/brain-app/deploy/deploy.sh'
```

`.github/workflows/deploy.yml` runs that same script over SSH. It is set to run
only when started by hand. After the first deploy has worked, add the `push`
trigger that is written out in the file. It needs four repository secrets:
`SSH_HOST`, `SSH_USER`, `SSH_KEY` and `SSH_KNOWN_HOSTS`.

## When Claude is signed out

The app says so, in the upload card and in the chat, in place of a generic
failure. Repeat step 4, then upload the document again.

---

## How it fits together

```
Browser
  │  HTTPS
Traefik :443          TLS, no buffering middleware
  │  HTTP (loopback)
Next.js :3003         one process, user `brain`, sign-in of its own
  │  spawn(), task on stdin, events on stdout
claude                working directory: /var/brain-data/<cluster>
  │  filesystem
/var/brain-data/<cluster>/
```

**Who writes what.** The app creates the cluster directory, `SCHEMA.md`, the
empty `index.md` and `log.md`, a git repository per cluster, and everything
under `.dashboard/`. The agent writes every page and keeps `index.md` and
`log.md` current. The app never writes a wiki page.

**What is reachable without signing in.** The login page, its endpoint, the
favicon and the hashed build output under `/_next/static/`. Nothing else. The
image optimizer is switched off and behind the login as well.

**Transports.** JSON for anything that finishes in milliseconds. Server-sent
events for filing progress and chat.

**Filing outlives its request.** `POST /api/upload` returns a job id as soon as
the file is on disk. A refresh, a navigation or a proxy timeout cannot stop a
write that runs for minutes. The browser reattaches.

## Two constraints that break quietly if violated

**Run exactly one process.** The per-cluster busy lock and the sign-in throttle
live in memory. A second instance, a load balancer or any clustering means two
filings can both rewrite `index.md` and one silently loses. No serverless, no
forking process manager.

**Never put Traefik's `buffering` middleware on these routes.** It reads the
whole response first, which turns chat and filing progress into one clump at
the end. That looks exactly like the agent not streaming. The same goes for a
global `compress` middleware unless it excludes `text/event-stream`.

## Known limits

- **The subscription login.** Anthropic describes that sign-in as meant for an
  individual's ordinary use and does not allow routing other people's requests
  through it. One shared login on a server is the owner's decision, taken
  knowingly for a small in-house team. Look at it again before more people use
  the app. See <https://code.claude.com/docs/en/legal-and-compliance>.
- **One shared login.** Everyone who signs in sees every cluster.
- **What the agent can read.** It is refused Claude's own folder, the app's env
  files and `/proc`. Whether the binary refuses other files outside the wiki
  has not been checked yet, so what the `brain` user is allowed to open is the
  limit to rely on. Keep that user away from anything that matters.
- **Documents are untrusted.** A document can contain text aimed at the agent.
  It has no shell and no network, plans in a throwaway copy, and every filing
  is checked and committed. That limits the damage to the cluster it was filed
  into, where git can undo it.
- **Dependencies.** `npm audit --omit=dev` reports one advisory that is left
  open: the copy of PostCSS inside Next 15, which has no fix short of Next 16.
  It concerns CSS from an untrusted source, and the only CSS that goes through
  it is the app's own, at build time. Move to Next 16 when there is time to
  test it.
- **No egress firewall.** The agent has no tool that reaches the network, and
  the box does not enforce that from outside.
