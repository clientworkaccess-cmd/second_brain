#!/usr/bin/env node
/**
 * Images in pages: how `![[photo.png]]` finds its file, what the image route
 * will and will not serve, and where an added image goes.
 *
 *   npm run check:assets
 *
 * The rules themselves (lib/assetPaths.ts, lib/assets.ts, the image branch of
 * lib/wikilinks.ts), called directly on a throwaway wiki.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-assets-'));
process.env.WIKI_ROOT = wikiRoot;

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { resolveImagePath, assetHref, imageEmbed, isImagePath, imageType } = await import(lib('assetPaths'));
const { listImages, forgetImages, imageFile, addImage } = await import(lib('assets'));
const { linkifyWikilinks } = await import(lib('wikilinks'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ------------------------------------------------------------ resolution
const IMAGES = ['raw/assets/Photo.png', 'raw/assets/deep/photo.png', 'wiki/entities/photo.png', 'wiki/logo.svg', 'notes/a b.jpg'];
check('what counts as an image', isImagePath('a.PNG') && isImagePath('x/y.webp') && !isImagePath('a.md') && !isImagePath('png') && imageType('a.svg') === 'image/svg+xml' && imageType('a.txt') === null);
check('a bare name finds the file, case blind', resolveImagePath(IMAGES, 'photo.png') === 'raw/assets/Photo.png');
check('of several, the one in the page’s own folder wins', resolveImagePath(IMAGES, 'photo.png', 'wiki/entities') === 'wiki/entities/photo.png');
check('otherwise the shortest path', resolveImagePath(IMAGES, 'photo.png', 'wiki/concepts') === 'raw/assets/Photo.png');
check('a path is taken from the page’s folder first', resolveImagePath(IMAGES, '../../raw/assets/deep/photo.png', 'wiki/entities') === 'raw/assets/deep/photo.png');
check('then from the root', resolveImagePath(IMAGES, 'raw/assets/deep/photo.png', 'wiki/entities') === 'raw/assets/deep/photo.png' && resolveImagePath(IMAGES, './wiki/logo.svg') === 'wiki/logo.svg');
check('encoding, a leading slash and a heading are ignored', resolveImagePath(IMAGES, '/notes/a%20b.jpg') === 'notes/a b.jpg' && resolveImagePath(IMAGES, 'notes/a b.jpg#x') === 'notes/a b.jpg');
check('nothing climbs above the root', resolveImagePath(IMAGES, '../../../etc/photo.png', 'wiki') === null && resolveImagePath(IMAGES, '../photo.png') === null);
check('a name that is not there is null', resolveImagePath(IMAGES, 'nothing.png') === null && resolveImagePath(IMAGES, 'photo.md') === null && resolveImagePath(IMAGES, '') === null);
check('the address encodes the path', assetHref('ops', 'notes/a b.jpg') === '/api/asset?cluster=ops&path=notes%2Fa%20b.jpg');
check('an added image is embedded by its file name', imageEmbed('raw/assets/deep/photo.png') === '![[photo.png]]');

// --------------------------------------------------------- the linkifier
const known = new Map([['photo', 'entities/photo']]);
const images = (target) => (target.toLowerCase() === 'photo.png' ? '/api/asset?cluster=ops&path=raw%2Fassets%2Fphoto.png' : null);
const linked = linkifyWikilinks('See ![[photo.png]] and ![[Photo.png|300]] and ![[photo.png|A caption]] and ![[gone.png]] and [[photo]] and `![[photo.png]]`', 'ops', known, images);
check('an image embed becomes an image', linked.includes('![photo.png](/api/asset?cluster=ops&path=raw%2Fassets%2Fphoto.png)'), linked);
check('a number after the bar is a width', linked.includes('![Photo.png](/api/asset?cluster=ops&path=raw%2Fassets%2Fphoto.png "w=300")'));
check('anything else after the bar is the alt text', linked.includes('![A caption](/api/asset?cluster=ops&path=raw%2Fassets%2Fphoto.png)'));
check('an image that is not there is marked missing', linked.includes('[gone.png](/c/ops?missing=gone.png)'));
check('a page link is still a page link, and code is left alone', linked.includes('[photo](/c/ops/entities/photo)') && linked.includes('`![[photo.png]]`'));
check('without the images of the wiki, an embed is a link as before', linkifyWikilinks('![[photo.png]]', 'ops', known).includes('?missing=photo.png'));

// --------------------------------------------------------- on disk
const cluster = 'ops';
const dir = path.join(wikiRoot, cluster);
await fs.mkdir(path.join(dir, 'raw', 'assets', 'deep'), { recursive: true });
await fs.mkdir(path.join(dir, 'entities'), { recursive: true });
await fs.mkdir(path.join(dir, '.dashboard'), { recursive: true });
await fs.mkdir(path.join(dir, '_secrets'), { recursive: true });
await fs.mkdir(path.join(dir, '.git'), { recursive: true });
await fs.writeFile(path.join(dir, 'index.md'), '# Wiki Index\n');
await fs.writeFile(path.join(dir, 'SCHEMA.md'), '# Rules\n');
await fs.writeFile(path.join(dir, 'raw', 'assets', 'photo.png'), PNG);
await fs.writeFile(path.join(dir, 'raw', 'assets', 'deep', 'other.PNG'), PNG);
await fs.writeFile(path.join(dir, 'entities', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
await fs.writeFile(path.join(dir, 'entities', 'notes.txt'), 'not an image');
await fs.writeFile(path.join(dir, '.dashboard', 'hidden.png'), PNG);
await fs.writeFile(path.join(dir, '_secrets', 'token.png'), PNG);
await fs.writeFile(path.join(dir, '.git', 'objects.png'), PNG);
await fs.writeFile(path.join(wikiRoot, 'outside.png'), PNG);

try {
  const found = await listImages(cluster);
  check('every image of the wiki is listed, nothing else', JSON.stringify(found) === JSON.stringify(['entities/diagram.svg', 'raw/assets/deep/other.PNG', 'raw/assets/photo.png']), JSON.stringify(found));

  const photo = await imageFile(cluster, 'raw/assets/photo.png');
  check('an image is read with its type and size', photo.type === 'image/png' && photo.size === PNG.length && photo.name === 'photo.png');
  const refused = async (rel) => imageFile(cluster, rel).then(() => null, (err) => err.status ?? 'thrown');
  check('a page is not served as an image', (await refused('index.md')) === 400 && (await refused('SCHEMA.md')) === 400 && (await refused('entities/notes.txt')) === 400);
  check('nothing outside the wiki', (await refused('../outside.png')) === 400 && (await refused('..\\outside.png')) === 400 && (await refused('/outside.png')) === 400);
  check('nothing from a hidden or private folder', (await refused('.dashboard/hidden.png')) === 400 && (await refused('_secrets/token.png')) === 400 && (await refused('.git/objects.png')) === 400);
  check('a name that is not there is 404', (await refused('raw/assets/nothing.png')) === 404 && (await refused('raw/assets')) === 400);

  const added = await addImage(cluster, 'C:\\Users\\someone\\My Photo (1).PNG', PNG);
  check('an added image goes into raw/assets under a safe name', added.path === 'raw/assets/My Photo _1_.png' && (await fs.stat(path.join(dir, added.path))).size === PNG.length, added.path);
  const again = await addImage(cluster, 'My Photo (1).png', PNG);
  check('a second of the same name is kept apart', again.path === 'raw/assets/My Photo _1_-2.png', again.path);
  check('the list knows the new images at once', (await listImages(cluster)).includes(again.path));
  const notImage = await addImage(cluster, 'notes.txt', PNG).then(() => null, (err) => err.status);
  const empty = await addImage(cluster, 'empty.png', new Uint8Array()).then(() => null, (err) => err.status);
  const climbing = await addImage(cluster, '../../escape.png', PNG);
  check('only images, not empty, and the name cannot climb', notImage === 400 && empty === 400 && climbing.path === 'raw/assets/escape.png', `${notImage} ${empty} ${climbing.path}`);
  forgetImages();
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await fs.rm(wikiRoot, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
