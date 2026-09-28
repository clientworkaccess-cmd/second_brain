import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ingest spawns a child process and streams for minutes. Next must stay a single
  // long-lived Node server for the per-cluster busy lock to mean anything — see
  // ../context.md "Known limits". Do not deploy this serverless or clustered.
  output: 'standalone',

  // Pin the tracing root to this directory. Without it Next walks up looking for
  // a lockfile, finds an unrelated one further up the tree, and silently emits
  // the standalone bundle somewhere the systemd unit is not looking.
  outputFileTracingRoot: here,

  experimental: {
    // Uploads are whole documents, not avatars.
    serverActions: { bodySizeLimit: '50mb' },
  },
};

export default nextConfig;
