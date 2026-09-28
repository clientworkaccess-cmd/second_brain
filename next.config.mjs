import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ingest spawns a child process and streams for minutes. Next must stay a single
  // long-lived Node server for the per-cluster busy lock to mean anything — see
  // the README, "Two constraints". Do not deploy this serverless or clustered.
  output: 'standalone',

  // Pin the tracing root to this directory. Without it Next walks up looking for
  // a lockfile, finds an unrelated one further up the tree, and silently emits
  // the standalone bundle somewhere the systemd unit is not looking.
  outputFileTracingRoot: here,

  // The image optimizer is off. The app shows no images, and the optimizer is an
  // endpoint that fetches and decodes whatever it is pointed at; it has had
  // remote-code-execution advisories of its own. With this set, /_next/image
  // answers 404.
  images: { unoptimized: true },

  // No need to tell every caller what the server is built with.
  poweredByHeader: false,

  experimental: {
    // Uploads are whole documents, not avatars.
    serverActions: { bodySizeLimit: '50mb' },
  },
};

export default nextConfig;
