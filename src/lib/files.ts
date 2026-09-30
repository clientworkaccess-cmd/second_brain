import fs from 'node:fs/promises';

/**
 * The two questions asked of the disk everywhere. On their own so that the
 * modules which read the wiki and the ones which describe a cluster can both
 * use them without importing each other.
 */

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readIfPresent(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
