import fs from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { addImage, imageFile } from '@/lib/assets';
import { imageEmbed } from '@/lib/assetPaths';
import { exists } from '@/lib/clusters';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { SESSION_COOKIE } from '@/lib/env-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * An image of a wiki. GET serves one, by its path from the wiki's root; POST
 * adds one, from the editor, into `raw/assets`.
 *
 * Only images, only from inside the wiki (lib/assets.ts). Served with its own
 * type and `nosniff`, so that a file is never read as anything else, and an
 * SVG with a policy that runs nothing, in case one is opened on its own.
 */
export async function GET(req: NextRequest) {
  try {
    const cluster = assertClusterName(req.nextUrl.searchParams.get('cluster') ?? '');
    const image = await imageFile(cluster, req.nextUrl.searchParams.get('path') ?? '');
    const etag = `"${Math.floor(image.mtimeMs)}-${image.size}"`;
    const headers: Record<string, string> = {
      'content-type': image.type,
      etag,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${image.name.replace(/[^\w.\-]+/g, '_')}"`,
    };
    if (image.type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers });
    const bytes = new Uint8Array(await fs.readFile(image.file));
    return new NextResponse(new Blob([bytes], { type: image.type }), { status: 200, headers: { ...headers, 'content-length': String(bytes.byteLength) } });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const cluster = await named(form.get('cluster'));
    const file = form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, 'No image in the request');
    const added = await addImage(cluster, file.name, new Uint8Array(await file.arrayBuffer()));
    await audit({ event: 'image-added', client: clientOf(req), session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value), detail: `${cluster}: ${added.path}` });
    return NextResponse.json({ ...added, embed: imageEmbed(added.path) }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

async function named(value: unknown): Promise<string> {
  const cluster = assertClusterName(String(value ?? ''));
  if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
  return cluster;
}

function fail(err: unknown) {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error('[api/asset]', err);
  return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
}
