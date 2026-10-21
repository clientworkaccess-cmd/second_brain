import { listClusters } from './clusters';
import { HttpError, assertClusterName } from './config';
import { searchCluster } from './search';
import { backlinksOf, listPages, loadWiki, readLog, readPage } from './wiki';
import { resolveLink } from './wikilinks';

/**
 * The brain as an MCP server (Model Context Protocol), for Claude: the
 * JSON-RPC messages of the Streamable HTTP transport, answered as plain JSON
 * (no event stream, no sessions), and the tools.
 *
 * The tools only read. They see what the app shows: the brains, their pages,
 * search, the log. Never the raw sources, the app's own files or anything
 * outside a brain. Who may call them is decided before this (app/mcp/route.ts
 * and lib/oauth.ts).
 */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PAGE_MAX_CHARS = 60_000;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

/** What a tool call did, for the audit trail. */
export interface Called {
  tool: string;
  brain?: string;
  page?: string;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, called: Called) => Promise<string>;
}

const brainArg = {
  type: 'string',
  description: 'The brain to use, by name (from list_brains). May be left out when there is only one.',
};

/** The brain a call means: the one named, or the only one there is. */
async function brainOf(args: Record<string, unknown>, called: Called): Promise<string> {
  const named = typeof args.brain === 'string' ? args.brain.trim().toLowerCase() : '';
  const brains = await listClusters();
  if (!named) {
    if (brains.length === 1) return (called.brain = brains[0].name);
    throw new ToolError(`Say which brain: ${brains.map((b) => b.name).join(', ') || 'there are none yet'}.`);
  }
  const name = assertClusterName(named);
  if (!brains.some((b) => b.name === name)) throw new ToolError(`There is no brain called "${name}". There are: ${brains.map((b) => b.name).join(', ')}.`);
  return (called.brain = name);
}

/** A page by its path or its title, as a wikilink would name it. */
async function slugOf(brain: string, page: unknown): Promise<string> {
  const said = typeof page === 'string' ? page.trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '') : '';
  if (!said) throw new ToolError('Say which page, by its title or its path.');
  const wiki = await loadWiki(brain);
  if (wiki.entries.has(said)) return said;
  const found = resolveLink(wiki.names, said);
  if (found && wiki.entries.has(found)) return found;
  throw new ToolError(`There is no page "${said}" in ${brain}. Use search_brain to find it.`);
}

class ToolError extends Error {}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[… cut here: the page is longer than ${max} characters]` : text;
}

const count = (n: unknown, fallback: number, max: number): number => {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), max) : fallback;
};

export const TOOLS: Tool[] = [
  {
    name: 'list_brains',
    title: 'List brains',
    description: 'The brains (knowledge bases) there are, with what each is about and how many pages it has. Start here when you do not know which brain to use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, called) {
      called.tool = 'list_brains';
      const brains = await listClusters();
      if (brains.length === 0) return 'There are no brains yet.';
      return brains.map((b) => `- ${b.name}: ${b.title}${b.scope ? `. ${b.scope}` : ''} (${b.pageCount} pages${b.updatedAt ? `, last changed ${b.updatedAt.slice(0, 10)}` : ''})`).join('\n');
    },
  },
  {
    name: 'search_brain',
    title: 'Search a brain',
    description: 'Search the pages of a brain by words. Returns page titles, their paths and the line around the match. Use read_page to read one. Search a few ways (names, synonyms) when the first search finds little.',
    inputSchema: {
      type: 'object',
      properties: { brain: brainArg, query: { type: 'string', description: 'The words to look for.' }, limit: { type: 'number', description: 'At most this many pages (1–30, default 15).' } },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, called) {
      called.tool = 'search_brain';
      const brain = await brainOf(args, called);
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new ToolError('Say what to search for.');
      if (query.length > 200) throw new ToolError('That search is too long.');
      const hits = await searchCluster(brain, query, count(args.limit, 15, 30));
      if (hits.length === 0) return `Nothing in ${brain} matches "${query}".`;
      return hits.map((h) => `- ${h.title} (${h.slug})\n  ${h.snippet}`).join('\n');
    },
  },
  {
    name: 'read_page',
    title: 'Read a page',
    description: 'Read one page of a brain in full: its properties, its text, the pages it links to and the pages that link to it. Name it by its title or its path. "index" is the brain\'s table of contents.',
    inputSchema: {
      type: 'object',
      properties: { brain: brainArg, page: { type: 'string', description: 'The page title (as in [[Title]]) or its path, e.g. "entities/warehouse-team" or "index".' } },
      required: ['page'],
      additionalProperties: false,
    },
    async run(args, called) {
      called.tool = 'read_page';
      const brain = await brainOf(args, called);
      const slug = await slugOf(brain, args.page);
      called.page = slug;
      const [page, backlinks] = await Promise.all([readPage(brain, slug), backlinksOf(brain, slug)]);
      const props = page.properties.length ? `${page.properties.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n` : '';
      const linked = page.links.length ? `\n\nLinks to: ${[...new Set(page.links)].slice(0, 100).join(', ')}` : '';
      const linking = backlinks.length ? `\nLinked from: ${backlinks.slice(0, 100).map((b) => b.title).join(', ')}` : '';
      return `# ${page.title}\nPath: ${page.slug} · updated ${page.updatedAt.slice(0, 10)}\n\n${props}${clip(page.body.trim(), PAGE_MAX_CHARS)}${linked}${linking}`;
    },
  },
  {
    name: 'list_pages',
    title: 'List pages',
    description: 'The pages of a brain, folder by folder (titles and paths). Give a folder to list only that one.',
    inputSchema: {
      type: 'object',
      properties: { brain: brainArg, folder: { type: 'string', description: 'Only this folder, e.g. "entities".' } },
      additionalProperties: false,
    },
    async run(args, called) {
      called.tool = 'list_pages';
      const brain = await brainOf(args, called);
      const listing = await listPages(brain);
      const only = typeof args.folder === 'string' ? args.folder.trim().replace(/\/$/, '') : '';
      const folders = listing.folders.filter((f) => !only || f.dir === only || f.dir.endsWith(`/${only}`));
      if (only && folders.length === 0) throw new ToolError(`There is no folder "${only}". There are: ${listing.folders.map((f) => f.dir).join(', ')}.`);
      const lines: string[] = [];
      if (!only && listing.root.length) lines.push(`## (top)\n${listing.root.map((p) => `- ${p.title} (${p.slug})`).join('\n')}`);
      for (const f of folders) lines.push(`## ${f.label} (${f.dir}), ${f.pages.length} pages\n${f.pages.map((p) => `- ${p.title} (${p.slug})`).join('\n')}`);
      return clip(`${listing.total} pages in ${brain}.\n\n${lines.join('\n\n')}`, PAGE_MAX_CHARS);
    },
  },
  {
    name: 'recent_changes',
    title: 'Recent changes',
    description: 'What was filed or changed in a brain lately, newest first, from its log: what came in and which pages it touched.',
    inputSchema: {
      type: 'object',
      properties: { brain: brainArg, limit: { type: 'number', description: 'At most this many entries (1–50, default 15).' } },
      additionalProperties: false,
    },
    async run(args, called) {
      called.tool = 'recent_changes';
      const brain = await brainOf(args, called);
      const entries = await readLog(brain, count(args.limit, 15, 50));
      if (entries.length === 0) return `Nothing has been logged in ${brain} yet.`;
      return entries.map((e) => `- ${e.when} · ${e.action} · ${e.subject}${e.details.length ? `\n${e.details.slice(0, 8).map((d) => `  ${d}`).join('\n')}` : ''}`).join('\n');
    },
  },
];

export const INSTRUCTIONS =
  "The owner's second brain: the businesses' knowledge, kept as linked pages. Use list_brains to see what there is, search_brain to find pages and read_page to read them (\"index\" is a brain's table of contents). Facts about the businesses come from these pages; name the pages you used. Read-only.";

function toolList() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } }));
}

const ok = (id: RpcRequest['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * One JSON-RPC message. A notification (no id) gets no answer: null.
 * `onCall` hears of every tool call, for the audit trail.
 */
export async function handleRpc(message: unknown, version: string, onCall?: (called: Called, failed: boolean) => void): Promise<RpcResponse | null> {
  if (!message || typeof message !== 'object' || (message as RpcRequest).jsonrpc !== '2.0' || typeof (message as RpcRequest).method !== 'string') {
    return fail((message as RpcRequest | null)?.id ?? null, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = message as RpcRequest;
  const notification = id === undefined;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'second-brain', title: 'Second Brain', version },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return notification ? null : ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolList() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(id, -32602, `No tool called "${name}"`);
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      const called: Called = { tool: name };
      try {
        const text = await tool.run(args, called);
        onCall?.(called, false);
        return ok(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        onCall?.(called, true);
        // What the model can act on is said; anything else stays in the server's log.
        const said = err instanceof ToolError || err instanceof HttpError ? err.message : 'That did not work on the server.';
        if (!(err instanceof ToolError || err instanceof HttpError)) console.error('[mcp]', name, err);
        return ok(id, { content: [{ type: 'text', text: said }], isError: true });
      }
    }
    default:
      if (notification) return null; // notifications/initialized, notifications/cancelled and the like
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
