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

  // Where an MCP client looks for how to sign in (lib/oauth.ts). Public in lib/gate.ts under these names.
  async rewrites() {
    return [
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/resource-metadata' },
      { source: '/.well-known/oauth-protected-resource/mcp', destination: '/api/oauth/resource-metadata' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/server-metadata' },
      { source: '/.well-known/oauth-authorization-server/mcp', destination: '/api/oauth/server-metadata' },
      { source: '/.well-known/openid-configuration', destination: '/api/oauth/server-metadata' },
    ];
  },

  experimental: {
    // Uploads are whole documents, not avatars.
    serverActions: { bodySizeLimit: '50mb' },
  },
};

export default nextConfig;
