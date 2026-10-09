# Second Brain

The web side of Second Brain: the team's wiki with an agent behind it. Upload a document, read what the agent
proposes to file, approve it, and the pages are written. Ask a question and get
an answer with the pages it came from.

Next.js, one process. The agent is Claude Code, started as a child process and
signed in with the team's Claude subscription. There is no API key anywhere.

**Where this stands.** Stage 1 of 3, everything the older dashboard did on
Claude Code instead of Hermes, is done. Stage 2, the real wiki's structure, is
in: a wiki kept by hand with Claude Code can be brought in as it is, and its
facets are read, checked and used (see "Two layouts"). Stage 3, the desktop app's
editor and its WebGL graph, is in.

It looks and is laid out like the Second Brain desktop app, on purpose:
[`DESIGN.md`](DESIGN.md). What the app assumes about the Claude binary, and what
has been checked: [`docs/claude-contract.md`](docs/claude-contract.md).

The product is called Second Brain. The package, the service and the folders on
the server keep the name `brain-app`.

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
three are set; there is no built-in login. `npm run totp-secret` prints a fourth
line, `AUTH_TOTP_SECRET`, and the key to add to an authenticator app; set, the
sign-in asks for the app's six-digit code too. Locally it is easier left out.

`.env.example` points `CLAUDE_CMD` at `scripts/fake-claude.mjs`, a stand-in that
speaks the same protocol as the real binary, writes plausible pages and streams
a plausible answer. The whole UI works against it.

`npm run dev` compiles pages as they are asked for, which makes the first visit
to each one slow and can leave a sign-in hanging. To judge how the app behaves,
run the build:

```bash
npm run build && npm run serve
```

## Checks

| Command | What it holds the app to |
|---|---|
| `npm run check` | The six below, in order |
| `npm run check:stream` | The stream parser, against streams captured from the real binary and against the stand-in |
| `npm run check:auth` | What gets through without a session, what counts as a session, the password, the throttle |
| `npm run check:pipeline` | Plan, approve, reject, revise, a stale plan, a signed-out agent, a planner that misbehaves, a wiki that files at once, and the undo |
| `npm run check:lint` | The check that runs after every filing |
| `npm run check:pages` | Reading a page does nothing but read it, whatever is written at its top |
| `npm run check:layout` | Both layouts, and above all a brain: reading it, filing into it, what is committed, the check after filing, the whole-wiki check, the command line, and that 350 pages are read once |
| `npm run check:facets` | The facets of a brain: read from its registry and its rules, what a page's block gets wrong, the check after filing, the plan, a brain made from the interview, callouts |
| `npm run check:design` | The look: the colours against `DESIGN.md`, dark mode complete, no class name that Tailwind also uses, the outline and the links |
| `npm run check:live` | The built app, started the way the server starts it and used over HTTP: sign-in, the second factor, sessions ended one by one and all at once, redirects, one document from upload to filed page, one filed at once, one discarded, one undone, chat, the editor's reads and writes, images served, refused and added, a page renamed and one deleted, the trail, a signed-out agent; the sign-in through the captcha and a code by email, by text and by the app. Needs `npm run build` first |
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
sudo npm --prefix /opt/brain-app run totp-secret
sudoedit /opt/brain-app/.env
```

The sign-in code needs a way out: the `SMTP_*` lines for email (a mailbox
with an app password), or `GHL_*` for texts, and where codes go in
`AUTH_CODE_EMAIL` and `AUTH_CODE_PHONE`. See `.env.example`.

```bash
sudo chown root:root /opt/brain-app/.env && sudo chmod 600 /opt/brain-app/.env
```

`totp-secret` prints the second factor: the `AUTH_TOTP_SECRET` line for the
env file and the key to add to an authenticator app on the phone. Do it now,
before the site is reachable; it can be left out, and the sign-in then takes
the password alone.

In `.env`, besides the sign-in lines:

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
file-provider directory; on a host that runs nginx, `deploy/nginx-brain.conf`
instead, then `certbot --nginx` for the certificate (the file says how). The
app needs HTTPS for its captcha.

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

## Sign-in

One login, shared, in up to three steps. First a captcha and the password:
the captcha is ALTCHA, self-hosted, a small puzzle the browser solves, signed
by the app and good once, with nothing sent anywhere else (`AUTH_CAPTCHA=off`
switches it off). Then, where a second factor is set up, a six-digit code:
emailed (`SMTP_*`, a Google Workspace mailbox with an app password works as
is) or texted through GoHighLevel (`GHL_API_KEY`, `GHL_LOCATION_ID`; the
number must be a contact there), to the address and number in
`AUTH_CODE_EMAIL` and `AUTH_CODE_PHONE`, masked on screen. Under "Other ways"
the authenticator app (`AUTH_TOTP_SECRET`). A code lives ten minutes, is tried
five times at most and taken once; three codes per sign-in, half a minute
apart. With none of the three set up, the password alone signs in: a dev
machine. Five wrong guesses of password or code block that address for a
while. `CODE_CAPTURE_DIR` writes codes to a folder instead of sending them,
for the checks; never set it on the server.

The captcha needs HTTPS (or localhost): browsers only give a page the crypto
it solves the puzzle with on a secure page. On plain HTTP it fails every time,
so put the app behind the proxy with a certificate, or set `AUTH_CAPTCHA=off`
until it is.

The password is changed on the Security page, from the current one, or reset
from "Forgot your password?" on the sign-in page: the address, the captcha,
then a code the same ways as a sign-in code, and the new password with it.
Either one ends every session there was. The new hash is kept in
`.dashboard/auth.json`; from then on `AUTH_PASSWORD_HASH` in the env file is
only the first password. To go back to the env one, remove `passwordHash`
from that file and restart. With no way to send a code set up there is
nothing to reset with, and the page does not offer it: run
`npm run hash-password` on the server instead.

A session lives in a signed cookie for thirty days. What the server keeps about
sessions is in `<WIKI_ROOT>/.dashboard/auth.json`: which are open, which were
ended, and an epoch that "Sign out everywhere" moves on, so that every cookie
from before it is refused. The middleware learns of both through
`/api/auth/state` and keeps them for five seconds, which is the most a session
ended elsewhere can go on for.

The Security page (the shield in the sidebar of the front page) lists the
browsers that are signed in, from where and since when, and ends any of them,
or all at once. It also shows the trail: every sign-in and refusal, every
session ended, every wiki made, every setting changed, every document read,
filed, discarded or undone, every page saved — when, from where and by which
session. The trail is `<WIKI_ROOT>/.dashboard/audit.log`, one line of JSON per
event, appended and never rewritten, set aside as `audit-1.log` past 8 MB. It
never holds a password, a code, a cookie or a page's text.

To move the second factor to another phone: `npm run totp-secret` again, set
the new secret, restart, add the new key to the app. To turn it off, empty the
line and restart. Changing `SESSION_SECRET` signs everyone out as well.

## Two layouts

A wiki is a folder under `WIKI_ROOT`. There is no list of them anywhere: the
app reads the folders. Two layouts are recognised, from what is in the folder.

| | A cluster | A brain |
|---|---|---|
| Made by | this app, from the interview on the "New cluster" page | a person and their own Claude Code, before it came here |
| Told apart by | `index.md` at the top | `wiki/index.md` |
| The rules | `SCHEMA.md` | `CLAUDE.md` |
| The pages | `entities/`, `concepts/`, `comparisons/`, `queries/` beside the rules | `wiki/sources/`, `entities/`, `concepts/`, `synthesis/`, plus `overview.md` and `businesses.md` beside the index |
| Links | by name: `[[Mark Chen]]` | by file name: `[[mark-chen]]` |
| Sources | `raw/`, under the name they were uploaded by | `raw/`, under the day they were filed: `2026-09-22-q3-board-pack.md`, with the uploaded file beside it |
| A page for each source | no | yes, in `wiki/sources/` |
| The rules the agent is given | `prompts/llm-wiki.md` | `prompts/brain-wiki.md`, which defers to the folder's own `CLAUDE.md` |
| What the agent may write | anything in the folder but the rules and the sources | `wiki/` and nothing else |
| Committed after a filing | the folder | `wiki/`, `raw/` and `CLAUDE.md`, and nothing else in the folder |
| Facets | none | `business` and `area` on every page: the businesses from `wiki/businesses.md`, the areas from the table in `CLAUDE.md` |

Both are made from the "New cluster" interview. A folder of pages that neither
layout names is shown all the same. Everything that knows one layout from the
other is in `src/lib/layout.ts`.

**Facets.** In a brain a folder says what kind of page it holds and nothing
else; which business a page concerns and what kind of work it is about are in
the block at its top. The app reads the values a page may carry from the wiki
itself, so a business added to the registry page is known at once. The page
tree and the search filter by them, the graph groups by them, a page shows them
as links to every page that shares them, and a plan says what each page it
proposes is about. After every filing the check reports a page whose block
breaks the rules: a business the registry does not have, an area too many, a
type that is not the folder's, a date that is not a date. Reported, never
refused: the pages stay as the agent wrote them, and a person decides.

**Bringing a brain in.** Copy the folder into `WIKI_ROOT` under a name in
lower case, digits and hyphens (`northwind-brain`, not `Northwind-Brain`), owned by
the service user. It appears on the front page at once. The first filing into
it makes it a git repository, with a commit of what it held before, so that
every filing can be undone. Leave out anything in the folder that does not
belong to the wiki: the agent can read the whole folder, and a working copy of
a mailbox is not something to hand it.

To try the app with a brain of real size without one:

```bash
npm run gen-brain -- .wiki-dev/northwind --pages 350 --links 10
```

Everything in it is made up.

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

**Who writes what.** The app creates a cluster's directory, `SCHEMA.md`, the
empty `index.md` and `log.md`, a git repository per wiki, and everything
under `.dashboard/`. The agent writes every page and keeps the index and the
log current. The app never writes a wiki page.

**What is reachable without signing in.** The login page, its endpoint, the
favicon and the hashed build output under `/_next/static/`. Nothing else. The
image optimizer is switched off and behind the login as well.

**Transports.** JSON for anything that finishes in milliseconds. Server-sent
events for filing progress and chat.

**Filing waits for approval, unless a person decides otherwise.** Per wiki,
in the About panel: every plan is shown first (the default), or a plan is
carried out as soon as it is made. An automatic filing reports what it wrote,
and any filing can be undone: the commit that captured it is reverted, pages
and source together, in a commit of its own. A filing that a later one built
on cannot be undone on its own; undo the later one first.

**A page can be edited by hand.** "Edit" in the status bar opens the page in
the desktop app's editor: live preview, the same formatting commands, `[[`
completion. What is typed is saved on its own a moment after the typing stops.
A page that changed on disk since it was opened is not overwritten: the
writer is told and chooses. "Done" saves, makes a restore point, and goes
back to reading. A new page starts from the page tree, with the block the
rules ask for already in it. Only pages can be written this way: not the
rules, not the sources, nothing outside the pages. Beside every page, the Graph panel
shows the page's own neighbourhood: the pages one or two links away, this
one marked; a node opens its page. A page can be renamed or
deleted from the status bar. A rename is a new title: the file name follows
it, and so does every link to the page, in every page and in the index
(links written as an alias stay). A delete says first how many pages link
here, then takes the page out and its line out of the index. Both make a
restore point.

**Images show in pages.** `![[photo.png]]` shows the file, found by its name
(one in the page's own folder first, then the shortest path); `![[photo.png|300]]`
sets the width; `![](../raw/assets/photo.png)` names it by path. An image
pasted or dropped into the editor is added to the wiki's `raw/assets` and
embedded where the cursor is. Only images are served (png, jpg, gif, webp,
avif, bmp, svg), only from inside the wiki, never from a hidden or private
folder, and never a page's text. A remote image in a document is left out:
its address can tell someone who opened the page.

**Every filing is on record.** The Filings panel on a wiki's front page lists
them, newest first, with what became of each: filed, needing attention,
waiting for a decision, discarded, failed, undone. A filing in the wiki can be
undone from there; a plan waiting in another browser can be picked up in this
one.

**The wiki, held to its rules.** The check page (the list icon in the page
tree's header) looks at every page: links both ways, the index both ways,
every block against the rules, and files that would steer a run. Nothing is
changed; a person reads the report and decides. The check after a filing
looks only at what that filing touched.

**Conversations are kept.** Every question belongs to a conversation, and the
app keeps every conversation, with each question and answer, under
`.dashboard/conversations/<wiki>/`: they are listed in the sidebar's Chats tab,
newest first, can be renamed and deleted, and reopen the same on any browser.
The agent remembers what was said: each question resumes Claude Code's own
session for the conversation; when the binary no longer has it (cleaned up,
or the server moved), the next question is given a recap from the app's record
and the conversation carries on.

**Discuss or Work.** Beside the question. In Discuss, the default, the agent
reads and answers and cannot change anything. In Work it may write pages when
asked to ("write that down", "add a page for…"), where a filing may and under
the same deny rules. A turn in Work holds the wiki as a filing does (a filing
meanwhile is refused, and the other way round), the wiki is checked afterwards
as after a filing, and what it wrote is one restore point: the answer shows the
pages it changed, what the check found, and an Undo. A turn in Work that the
reader stops watching is let finish and is in the conversation when they come
back.

**A question chooses its model.** Beside the question: Default (what the
server is set to in `CLAUDE_MODEL`, or Claude Code's own), Opus, Sonnet or
Haiku, by Claude Code's aliases, so each follows the newest of its family.
Remembered per wiki in the browser; each answer says which model gave it. A
conversation can change model between questions.

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
