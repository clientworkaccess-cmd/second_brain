import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, SETTINGS_DIR, assertClusterName } from './config';
import { readIfPresent } from './files';

/**
 * What a person has decided about a wiki, kept by the app and not in the
 * wiki's folder, where the agent works.
 *
 * One decision so far: whether a filing waits for approval. A wiki that was
 * kept by hand is used to being filed into without a plan being shown first,
 * and its rules may say so. Filing at once is a decision a person makes here,
 * per wiki, and every automatic filing can be undone afterwards.
 */

export type Filing = 'review' | 'automatic';

export interface ClusterSettings {
  /** `review`: every plan waits for a person. `automatic`: a plan is carried out as soon as it is made. */
  filing: Filing;
}

const DEFAULTS: ClusterSettings = { filing: 'review' };

export async function readSettings(cluster: string): Promise<ClusterSettings> {
  const raw = await readIfPresent(settingsFile(cluster));
  if (!raw) return { ...DEFAULTS };
  try {
    return normalise(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS }; // a file nobody can read means the defaults, not a wiki nobody can use
  }
}

export async function writeSettings(cluster: string, patch: Partial<ClusterSettings>): Promise<ClusterSettings> {
  const next = normalise({ ...(await readSettings(cluster)), ...patch });
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(settingsFile(cluster), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** Whatever is on disk or in a request, as settings, or an error a reader can act on. */
export function normalise(input: unknown): ClusterSettings {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const filing = o.filing ?? DEFAULTS.filing;
  if (filing !== 'review' && filing !== 'automatic') throw new HttpError(400, 'Filing is "review" or "automatic"');
  return { filing };
}

function settingsFile(cluster: string): string {
  return path.join(SETTINGS_DIR, `${assertClusterName(cluster)}.json`);
}
