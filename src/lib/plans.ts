import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, PLANS_DIR } from './config';
import { ensureDashboardDirs, readIfPresent } from './clusters';
import { PAGE_DIRS, type PageDir, type Snapshot } from './wiki';

/**
 * The proposed ingest — what the agent understood, before anything is written.
 *
 * Two rules shape this file.
 *
 * It is written in the founder's language, not the filesystem's. The agent
 * reports "Mark Chen, a person, owns the Q4 forecast"; it never reports
 * "entities/mark-chen.md". Approving is meant to be a judgement about whether
 * the document was understood, and a list of file paths does not ask that
 * question.
 *
 * The agent therefore never supplies a path. `dirFor`/`slugFor` below derive
 * one from the kind and the name, here, in the dashboard. That keeps naming
 * consistent when the agent is sloppy, and means a malformed plan cannot steer
 * a write outside the cluster — clusterPath() would refuse it, but the better
 * version is that no agent-supplied path ever reaches it.
 */

export type ItemKind = 'entity' | 'concept' | 'comparison' | 'query';

const KIND_TO_DIR: Record<ItemKind, PageDir> = {
  entity: 'entities',
  concept: 'concepts',
  comparison: 'comparisons',
  query: 'queries',
};

const KINDS = Object.keys(KIND_TO_DIR) as ItemKind[];

export interface PlanPage {
  kind: ItemKind;
  /** Human-readable: "Mark Chen", "Refund Policy". */
  name: string;
  /** One line, as it would read in the index. */
  summary: string;
  /** Verbatim from the source. This is what makes the plan checkable. */
  quote: string;
  /** True when the wiki already has this page and the agent means to extend it. */
  existing: boolean;
}

export interface PlanDecision {
  statement: string;
  by: string | null;
  quote: string;
}

export interface PlanLink {
  from: string;
  to: string;
  why: string;
}

export interface PlanSkip {
  what: string;
  why: string;
}

/**
 * The cluster's state at the moment the plan was made. Compared again at
 * approval: if the wiki moved underneath a plan, executing it would write
 * against a wiki the agent never saw.
 *
 * Stored as pairs, not a Map. `JSON.stringify(new Map())` is `{}`, so a Map
 * here would serialize to nothing and the staleness check would quietly
 * compare empty to empty and always pass.
 */
export interface Basis {
  pages: [string, string][];
  links: number;
}

export interface Plan {
  jobId: string;
  cluster: string;
  filename: string;
  createdAt: string;
  /** 1 for the first plan, incremented by each revision. */
  revision: number;
  /** What the human asked for when they sent it back. Null on the first pass. */
  feedback: string | null;
  pages: PlanPage[];
  decisions: PlanDecision[];
  links: PlanLink[];
  skipped: PlanSkip[];
  basis: Basis;
}

export function toBasis(snap: Snapshot): Basis {
  return { pages: [...snap.pages.entries()], links: snap.links };
}

/**
 * Has the cluster changed since this plan was made? Compares page fingerprints
 * only — a link count that moved without any page changing is not possible.
 */
export function basisIsStale(basis: Basis, now: Snapshot): boolean {
  const then = new Map(basis.pages);
  if (then.size !== now.pages.size) return true;
  for (const [slug, fp] of now.pages) {
    if (then.get(slug) !== fp) return true;
  }
  return false;
}

export function dirFor(kind: ItemKind): PageDir {
  return KIND_TO_DIR[kind];
}

/**
 * "Mark Chen" -> "mark-chen". Strict: everything outside [a-z0-9-] goes, which
 * also means no separators, no dots, and nothing that could climb a directory.
 */
export function slugFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** The path this page will be written to, relative to the cluster. */
export function pathFor(page: PlanPage): string {
  return `${dirFor(page.kind)}/${slugFor(page.name)}.md`;
}

export function planPath(jobId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) throw new HttpError(400, 'Malformed job id');
  return path.join(PLANS_DIR, `${jobId}.json`);
}

/**
 * Read a plan back off disk.
 *
 * Deliberately not `JSON.parse(...) as Plan`. This file is written by the
 * agent, so it is untrusted input sitting directly on the path to a write —
 * a bare cast would surface a malformed plan as a crash somewhere inside the
 * approve handler, after the staging file had already moved.
 */
export async function readPlan(jobId: string): Promise<Plan | null> {
  const raw = await readIfPresent(planPath(jobId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return validatePlan(parsed);
  } catch {
    return null;
  }
}

export async function writePlan(plan: Plan): Promise<void> {
  await ensureDashboardDirs();
  await fs.writeFile(planPath(plan.jobId), JSON.stringify(plan, null, 2), 'utf8');
}

export async function deletePlan(jobId: string): Promise<void> {
  await fs.rm(planPath(jobId), { force: true });
}

/**
 * Turn whatever the agent produced into a Plan, or throw.
 *
 * Tolerant about absence — a document with no decisions in it is normal, and an
 * agent that omits the key rather than sending `[]` should not fail the ingest.
 * Strict about shape: anything that survives here is safe to act on.
 */
export function validatePlan(input: unknown): Plan {
  const o = asObject(input, 'plan');

  const pages = asArray(o.pages, 'pages').map((raw, i) => {
    const p = asObject(raw, `pages[${i}]`);
    const kind = String(p.kind ?? '').toLowerCase();
    if (!KINDS.includes(kind as ItemKind)) {
      throw new HttpError(422, `pages[${i}].kind must be one of ${KINDS.join(', ')}`);
    }
    const name = str(p.name).trim();
    if (!name) throw new HttpError(422, `pages[${i}].name is empty`);
    if (!slugFor(name)) throw new HttpError(422, `pages[${i}].name has no usable characters`);
    return {
      kind: kind as ItemKind,
      name,
      summary: str(p.summary).trim(),
      quote: str(p.quote).trim(),
      existing: p.existing === true,
    };
  });

  const decisions = asArray(o.decisions, 'decisions').map((raw, i) => {
    const d = asObject(raw, `decisions[${i}]`);
    return {
      statement: str(d.statement).trim(),
      by: str(d.by).trim() || null,
      quote: str(d.quote).trim(),
    };
  });

  const links = asArray(o.links, 'links').map((raw, i) => {
    const l = asObject(raw, `links[${i}]`);
    return { from: str(l.from).trim(), to: str(l.to).trim(), why: str(l.why).trim() };
  });

  const skipped = asArray(o.skipped, 'skipped').map((raw, i) => {
    const s = asObject(raw, `skipped[${i}]`);
    return { what: str(s.what).trim(), why: str(s.why).trim() };
  });

  const basisRaw = isObject(o.basis) ? o.basis : {};
  const basis: Basis = {
    pages: asArray(basisRaw.pages, 'basis.pages')
      .filter((e): e is [string, string] => Array.isArray(e) && e.length === 2)
      .map(([k, v]) => [String(k), String(v)]),
    links: Number(basisRaw.links ?? 0) || 0,
  };

  return {
    jobId: str(o.jobId),
    cluster: str(o.cluster),
    filename: str(o.filename),
    createdAt: str(o.createdAt) || new Date().toISOString(),
    revision: Number(o.revision ?? 1) || 1,
    feedback: str(o.feedback).trim() || null,
    pages,
    decisions,
    links,
    skipped,
    basis,
  };
}

/**
 * The agent is asked for JSON in a file, but it is still a language model. Pull
 * the outermost JSON object out of whatever it wrote, so a stray "Here is the
 * plan:" preamble does not fail an otherwise good run.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the salvage path */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* keep going */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* give up below */
    }
  }
  throw new HttpError(422, 'The agent did not return a readable plan');
}

/** Counts for the review card, derived here so the UI does not recompute them. */
export function planTotals(plan: Plan): { newPages: number; updatedPages: number; links: number } {
  return {
    newPages: plan.pages.filter((p) => !p.existing).length,
    updatedPages: plan.pages.filter((p) => p.existing).length,
    links: plan.links.length,
  };
}

/** Every distinct file this plan would touch. Used for the execution prompt. */
export function targets(plan: Plan): { page: PlanPage; path: string }[] {
  const seen = new Set<string>();
  const out: { page: PlanPage; path: string }[] = [];
  for (const page of plan.pages) {
    const p = pathFor(page);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ page, path: p });
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (!isObject(v)) throw new HttpError(422, `${where} is not an object`);
  return v;
}

function asArray(v: unknown, where: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(422, `${where} is not a list`);
  return v;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

export { PAGE_DIRS };
