import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, ORIGINALS_DIR, STAGING_DIR, assertClusterName, clusterPath } from '@/lib/config';
import { ensureDashboardDirs, exists } from '@/lib/clusters';
import { startPlanning } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Receives pre-parsed Markdown content (or pasted text) along with optional
 * original binary files, formats SHA256 frontmatter, and stages the source in
 * .dashboard/staging/ — outside any cluster.
 *
 * It used to write straight into $WIKI_PATH/raw/ and spawn the agent. It no
 * longer does: nothing enters a cluster until a human has read the plan and
 * approved it. The file moves staging → raw/ in the approve handler, and a
 * rejected upload is deleted rather than left behind in raw/ forever.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const cluster = assertClusterName(String(form.get('cluster') ?? ''));

    const parsedText = String(form.get('parsedText') ?? '').trim();
    const rawFilename = String(form.get('filename') ?? 'document.md').trim();
    const file = form.get('file');

    if (!parsedText && !(file instanceof File)) {
      throw new HttpError(400, 'No content or file in request');
    }

    if (file instanceof File && file.size === 0) {
      throw new HttpError(400, 'Uploaded file is empty');
    }

    if (!(await exists(clusterPath(cluster)))) {
      throw new HttpError(404, `No cluster named "${cluster}"`);
    }

    await ensureDashboardDirs();

    const baseName = rawFilename || (file instanceof File ? file.name : 'pasted_text.md');
    const safeName = path.basename(baseName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'source.md';
    const mdFileName = safeName.endsWith('.md') ? safeName : `${path.parse(safeName).name}.md`;

    // 1. If original binary is provided, archive it in .dashboard/originals/.
    //    The path is recorded on the job: without it, rejecting an upload could
    //    not clean this up and originals/ would grow forever.
    let originalPath: string | null = null;
    if (file instanceof File) {
      originalPath = path.join(ORIGINALS_DIR, `${randomUUID()}__${safeName}`);
      await fs.writeFile(originalPath, Buffer.from(await file.arrayBuffer()));
    }

    // 2. Stage the markdown outside the cluster. The job id is not known yet,
    //    so a uuid keeps two uploads of the same filename apart.
    const stagedPath = path.join(STAGING_DIR, `${randomUUID()}__${mdFileName}`);

    // 3. Format SHA256 frontmatter over parsed content if not present
    let contentToWrite = parsedText;
    if (!contentToWrite.startsWith('---')) {
      const sha256 = createHash('sha256').update(parsedText).digest('hex');
      const today = new Date().toISOString().slice(0, 10);
      const frontmatter = [
        '---',
        `source_url: dashboard_upload://${safeName}`,
        `ingested: ${today}`,
        `sha256: ${sha256}`,
        '---',
        '',
      ].join('\n');

      contentToWrite = frontmatter + parsedText;
    }

    await fs.writeFile(stagedPath, contentToWrite, 'utf8');

    // 4. Read the document and propose a plan. Nothing is written to the
    //    cluster by this — the planning pass runs against a throwaway copy.
    const job = await startPlanning({
      cluster,
      filename: baseName,
      stagedPath,
      originalPath,
    });

    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[api/upload]', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
