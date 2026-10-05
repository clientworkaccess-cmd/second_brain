import { NextRequest, NextResponse } from 'next/server';
import { createBrain, createCluster, listClusters } from '@/lib/clusters';
import { HttpError } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({ clusters: await listClusters() });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? '').trim().toLowerCase();
    const cluster =
      body.layout === 'brain'
        ? await createBrain({
            name,
            scope: String(body.scope ?? ''),
            businesses: String(body.businesses ?? ''),
            questions: String(body.questions ?? ''),
          })
        : await createCluster({
            name,
            scope: String(body.scope ?? ''),
            entities: String(body.entities ?? ''),
            questions: String(body.questions ?? ''),
          });
    return NextResponse.json({ cluster }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error('[api/clusters]', err);
  return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
}
