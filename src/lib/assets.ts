import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, clusterPath } from './config';
import { assetHref, imageType, isImagePath } from './assetPaths';
import { layoutOf } from './layout';

/**
 * The images of a wiki: which files there are, reading one for the browser,
 * and adding one from the editor. The one place the app reads or writes a
 * file of a wiki that is not a page.
 *
 * Only images (by extension, see assetPaths.ts), only inside the wiki, never
 * from a folder whose name starts with `.` or `_` (`.git`, `.dashboard`,
 * `_secrets`). A page's text is never served this way either.
 */

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_DEPTH = 6;
/** For how long the list of images is trusted before the folders are read again: one page view asks several times. */
const SETTLED_MS = 300;

interface Kept {
  images: string[];
  at: number;
}

const globalForAssets = globalThis as typeof globalThis & { __wikiImages?: Map<string, Kept> };
const kept: Map<string, Kept> = (globalForAssets.__wikiImages ??= new Map());

/** Every image of the wiki, as paths from its root with `/`, sorted. */
export async function listImages(cluster: string): Promise<string[]> {
  const root = clusterPath(cluster);
  const slot = kept.get(root);
  if (slot && Date.now() - slot.at < SETTLED_MS) return slot.images;
  const images: string[] = [];
  await walk(root, '', images, 0);
  images.sort((a, b) => a.localeCompare(b));
  kept.set(root, { images, at: Date.now() });
  return images;
}

/** After a change the app made itself, the next look reads the folders again. */
export function forgetImages(cluster?: string): void {
  if (cluster === undefined) kept.clear();
  else kept.delete(clusterPath(cluster));
}

async function walk(dir: string, rel: string, out: string[], depth: number): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(path.join(dir, entry.name), relPath, out, depth + 1);
    } else if (entry.isFile() && isImagePath(entry.name)) {
      out.push(relPath);
    }
  }
}

export interface ImageFile {
  file: string;
  name: string;
  type: string;
  size: number;
  mtimeMs: number;
}

/** The file an image path names, checked. Throws an HttpError a route can answer with. */
export async function imageFile(cluster: string, rel: string): Promise<ImageFile> {
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /\0/.test(part) || part.startsWith('.') || part.startsWith('_'))) {
    throw new HttpError(400, 'Malformed image path');
  }
  const name = parts[parts.length - 1];
  const type = imageType(name);
  if (!type) throw new HttpError(400, 'Not an image');
  const file = clusterPath(cluster, ...parts);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new HttpError(404, 'No such image');
  }
  if (!stat.isFile()) throw new HttpError(404, 'No such image');
  if (stat.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'That image is too large to show');
  return { file, name, type, size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * An image added by a person, into the wiki's `raw/assets` folder under a
 * safe name that is not yet taken. Returns where it went and its address.
 */
export async function addImage(cluster: string, originalName: string, bytes: Uint8Array): Promise<{ path: string; href: string }> {
  if (bytes.byteLength === 0) throw new HttpError(400, 'The image is empty');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'Images up to 25 MB');
  const layout = await layoutOf(cluster);
  const base = path.basename(originalName.replace(/\\/g, '/'));
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
  if (!imageType(`x.${ext}`)) throw new HttpError(400, 'Only images (png, jpg, gif, webp, avif, bmp, svg)');
  const stem = (dot === -1 ? base : base.slice(0, dot)).replace(/[^\w.\- ]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'image';

  const dir = clusterPath(cluster, layout.rawDir, 'assets');
  await fs.mkdir(dir, { recursive: true });
  let name = `${stem}.${ext}`;
  for (let n = 2; await exists(path.join(dir, name)); n++) name = `${stem}-${n}.${ext}`;
  const file = path.join(dir, name);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, file);
  forgetImages(cluster);
  const rel = `${layout.rawDir}/assets/${name}`;
  return { path: rel, href: assetHref(cluster, rel) };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}
