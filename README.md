# Knowledge Graph — dashboard

The client-facing dashboard for the LLM Wiki platform. Next.js, single process,
talks to the Hermes agent across a `spawn` boundary.

Design of record: [`../files/design-handoff-2026-08-11.md`](../files/design-handoff-2026-08-11.md).
Operational state: [`../context.md`](../context.md). Visual system: [`Desing.md`](Desing.md).

---

## Run it locally

No Hermes, no API key, no client documents.

```bash
npm install
cp .env.example .env.local
npm run dev
```

`.env.example` already points `HERMES_CMD` at `scripts/fake-hermes.mjs`, a
stand-in that writes plausible pages and streams plausible progress. The entire
UI — upload, ingest diff, wiki browsing, chat — works against it.

**One caveat:** the fake streams line by line. Whether the real `hermes -z` does
that is unverified (T1a). If it does not, chat will feel materially different in
production than it does here. Judge the chat experience against the real binary.

## Run it on the VPS

```bash
git clone <repo> /opt/dashboard && cd /opt/dashboard && npm ci && npm run build
```

Then set the two lines that differ:

```bash
WIKI_ROOT=/var/llm_wiki
HERMES_CMD=/usr/local/bin/hermes
HERMES_ARGS=
```

Copy `deploy/dashboard.service` to `/etc/systemd/system/` and
`deploy/traefik-dynamic.yml` into your Traefik file-provider directory, then
`systemctl enable --now dashboard`.

## Updating

```bash
ssh root@vps '/opt/dashboard/deploy/deploy.sh'
```

Pushing to `main` runs that same script over SSH via
`.github/workflows/deploy.yml`. Three repo secrets are required: `SSH_HOST`,
`SSH_USER`, `SSH_KEY` (the private half of a keypair whose public half is in the
VPS user's `authorized_keys`).

Run the script by hand once before relying on the workflow. A pipeline whose
commands have never succeeded manually is impossible to debug — you cannot tell
the workflow apart from the SSH apart from the build.

---

## How it fits together

```
Browser
  │  HTTPS
Traefik :443          TLS, one shared password, no buffering middleware
  │  HTTP (loopback)
Next.js :3002         single process — see below
                      (3002 not 3000: another app owns 3000 on this box)
  │  spawn(), stdout pipe — not a network call
hermes                env: WIKI_PATH=/var/llm_wiki/<cluster>
  │  filesystem
/var/llm_wiki/<cluster>/
```

**Who writes what.** This app creates the cluster directory, `SCHEMA.md`,
per-cluster `git init`, and everything under `.dashboard/`. The agent creates
everything else — `index.md`, `log.md`, `raw/`, and every page. The dashboard
never writes a wiki page; doing so would be rebuilding the skill.

**Isolation is structural.** The agent is handed a `WIKI_PATH` it cannot reach
outside of. There is no `cd`, and no cluster manifest — a cluster *is* a
directory containing an `index.md`, so listing is a `readdir` and a filter.

**Transports.** JSON for anything that finishes in milliseconds. SSE for ingest
progress and chat, because both are one-way server→client and SSE inherits TLS,
auth, proxy config and reconnect from plain HTTP.

**Ingest outlives its request.** `POST /api/upload` returns a job id as soon as
the file is on disk. A refresh, a navigation, or a proxy timeout cannot kill a
write that runs for minutes. The browser reattaches over SSE.

---

## Two constraints that break quietly if violated

**Run exactly one process.** The per-cluster busy lock lives in memory. A second
instance, a load balancer, or any clustering means two ingests can both rewrite
`index.md` and one silently loses. No Vercel, no serverless, no forking process
manager.

**Never put Traefik's `buffering` middleware on these routes.** Traefik streams
by default and flushes recognised streaming responses immediately, so SSE needs
no special configuration — but `buffering` reads the whole response first, which
turns chat and ingest progress into one clump at the end. That is
indistinguishable from the agent not streaming and will send you debugging
Hermes instead of the proxy. Same applies to a global `compress` middleware
unless it excludes `text/event-stream`.

---

## Not built yet

- **Egress firewall / unprivileged user** (T0). Deferred by decision on
  2026-08-12; the gate is the first real client document, not the first run.
- **Containerised ingest** (T8). `--yolo` gives an agent unrestricted shell over
  documents we did not write. Uploaded files are untrusted input regardless of
  who uploaded them.
- **Post-ingest lint** (T8) — did `index.md` update, did `log.md` get its entry,
  are there orphan pages. Skill invocation is natural-language triggered and
  therefore probabilistic; this pass is not optional.
- **Nightly git commit cron** (T9).
- **Any user model.** One shared password at Caddy. "Sales can't see the HR
  cluster" is unbuilt work.
