# Changelog

What changed in Second Brain, newest first. Each entry names the pull request it came in. Add to
**Unreleased** with every change; when it is deployed, give the section the date.

## Unreleased

### Added
- **Memory.** The brain learns how its owner wants to be answered: preferences, corrections and feedback on
  answers. A background run (Sonnet, no tools) reads each finished conversation turn and changes the memory;
  the app writes it under `.dashboard/memory/` (`core.md`, always given to a turn; `topics/<name>.md`, read by
  the agent when a message touches one; `history/`, every earlier version). Nothing shows in the app. It learns
  only from what the owner said, never from pages, documents or the web, and filing never touches it.
  Duplicates are merged, a newer wish replaces an older one, and past 60 core entries it consolidates itself.
  `MEMORY=off` stops it; `MEMORY_MODEL` changes the model. Changes are in the audit log.
- **Who the brain is talking to.** Every conversation turn is told who the reader is, from
  `.dashboard/profile.md` on the server (not in the repo, since it names a real person). Without it, a general
  line is used.
- **Thinking, not only looking up.** A conversation turn tells a lookup from a request for analysis, strategy or
  advice, and for the latter uses the pages as evidence, then weighs, ranks by money, recency and risk, explains
  each problem with a fix, and recommends. General knowledge is allowed when it is labelled as such.
- **Writing rules.** Replies are simple, clear, natural and easy to read the first time, and do not read like AI.
- **Opus for thinking.** A message left to the default model that asks for analysis or advice is asked of Opus.
- **Documents sent in** (#27): `POST /api/ingest` takes documents n8n sends from the server itself (email digests, meeting transcripts) and files each like an upload, one at a time per brain, never the same `sourceId` twice. Refused if it came through nginx; optional `INGEST_TOKEN`.
- `GET /api/health`: public, says the server is up and its version, nothing else (#26).
- This changelog.

### Changed
- The reader sees "brain" everywhere in the app, never "wiki".

## 2026-10-12

- Work updates the page that exists and keeps one source per conversation; the web in Discuss; Ask reads like a
  conversation, with a serif reply, the reader's message on the right and a jump to the latest (#24).
- Ask: a message in a conversation, not a query; "the brain"; no citations in a reply (#23).

## 2026-10-11

- Work: what the reader says in a conversation is kept as the source to write from (#22).
- Ask: dictation, read aloud and Talk with the browser's own voice; a question box that grows (#21).

## 2026-10-09

- Conversations that are kept, named, remembered across sessions, and can write, with undo (#20).
- Ask: choose the model a question is asked of (#19).
- Graph: hide folders, pages and patterns from the drawing (#18).
- A forgotten password is reset from the sign-in page, and changed from the Security page (#17).

## 2026-10-08

- Sign-in in three steps: a captcha, the password, then a code by email, by text or from an authenticator app (#16).

## 2026-10-07

- Pages written on Windows are read, and so are areas under a `##` heading (#15).

## 2026-10-05

- The desktop app's editor and WebGL graph in the web app; every filing on record; filing at once per brain,
  undo for any filing; facets; a brain declares its layout; YAML front matter; the desktop look, search,
  backlinks and outline; the name Second Brain (#2 to #14).

## 2026-09-28

- Stage 1: the dashboard on Claude Code, with sign-in hardened (#1).
