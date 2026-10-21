import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listClusters } from './clusters';
import { HttpError, assertClusterName } from './config';
import { enqueue, ensureIngestWorker, listItems, readItem, type IngestItem } from './ingest';
import { getJob } from './jobs';
import { readPlan } from './plans';
import { searchCluster } from './search';
import { backlinksOf, listPages, loadWiki, readLog, readPage } from './wiki';
import { resolveLink } from './wikilinks';

/**
 * The brain as an MCP server (Model Context Protocol), for Claude, built on the
 * official TypeScript SDK (`@modelcontextprotocol/sdk`): app/mcp/route.ts makes
 * one of these per request and answers it over the SDK's Streamable HTTP
 * transport. Who may call it is decided before that (lib/oauth.ts).
 *
 * The tools read what the app shows (the brains, their pages, search, the
 * log), never the raw sources, the app's own files or anything outside a
 * brain. One writes: `file_document` sends a document in to be filed, the way
 * n8n sends email and transcripts (lib/ingest.ts). The app's own filing agent
 * plans and files it with the brain's rules, at once, and every filing can be
 * undone in the app. Claude never edits a page itself.
 */

const PAGE_MAX_CHARS = 60_000;
const STATUS_ITEMS = 5;

/** What a tool call did, for the audit trail. */
export interface Called {
  tool: string;
  brain?: string;
  page?: string;
  /** Set by a tool that changed something. */
  wrote?: boolean;
}

class ToolError extends Error {}

const brainArg = z.string().max(64).optional().describe('The brain to use, by name (from list_brains). May be left out when there is only one.');

/** The brain a call means: the one named, or the only one there is. */
async function brainOf(named: string | undefined, called: Called): Promise<string> {
  const name = (named ?? '').trim().toLowerCase();
  const brains = await listClusters();
  if (!name) {
    if (brains.length === 1) return (called.brain = brains[0].name);
    throw new ToolError(`Say which brain: ${brains.map((b) => b.name).join(', ') || 'there are none yet'}.`);
  }
  const checked = assertClusterName(name);
  if (!brains.some((b) => b.name === checked)) throw new ToolError(`There is no brain called "${checked}". There are: ${brains.map((b) => b.name).join(', ')}.`);
  return (called.brain = checked);
}

/** A page by its path or its title, as a wikilink would name it. */
async function slugOf(brain: string, page: string): Promise<string> {
  const said = page.trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '');
  if (!said) throw new ToolError('Say which page, by its title or its path.');
  const wiki = await loadWiki(brain);
  if (wiki.entries.has(said)) return said;
  const found = resolveLink(wiki.names, said);
  if (found && wiki.entries.has(found)) return found;
  throw new ToolError(`There is no page "${said}" in ${brain}. Use search_brain to find it.`);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[… cut here: the page is longer than ${max} characters]` : text;
}

/** The same document sent twice is filed once: its id is its content. */
export function sourceIdFor(brain: string, title: string, text: string): string {
  return `claude:${createHash('sha256').update(`${brain}\n${title.trim()}\n${text.trim()}`).digest('hex').slice(0, 40)}`;
}

/** One document sent in, as filing_status reports it. */
async function statusOf(item: IngestItem): Promise<string> {
  const head = `- ${item.title} (${item.id}) · sent ${item.receivedAt.slice(0, 16).replace('T', ' ')} UTC · ${item.state}`;
  if (item.state === 'failed') return `${head}\n  It could not be filed: ${item.error ?? 'no reason given'}`;
  if (!item.jobId) return `${head}\n  Waiting its turn.`;
  const [job, plan] = await Promise.all([getJob(item.jobId), readPlan(item.jobId)]);
  const lines = [head];
  if (job?.diff) lines.push(`  ${job.diff.newPages} new pages, ${job.diff.updatedPages} updated, ${job.diff.newConnections} new links${job.commit ? ` (saved as ${job.commit.slice(0, 7)}; it can be undone in the app)` : ''}`);
  else if (job) lines.push(`  ${job.status === 'planning' ? 'Being planned.' : job.status === 'executing' ? 'Being filed.' : `Filing: ${job.status}.`}`);
  if (plan?.pages.length) lines.push(`  Pages: ${plan.pages.map((p) => `${p.name}${p.existing ? ' (updated)' : ' (new)'}`).join(', ')}`);
  if (job?.error) lines.push(`  Problem: ${job.error}`);
  return lines.join('\n');
}

export const INSTRUCTIONS =
  "The owner's second brain: the businesses' knowledge, kept as linked pages. Use list_brains to see what there is, search_brain to find pages and read_page to read them (\"index\" is a brain's table of contents). Facts about the businesses come from these pages; name the pages you used. To add a document (one the user pastes or attaches), send its full text with file_document: the brain files it with its own rules, and filing_status says what it changed. Never file anything the user did not ask you to file.";

type Text = { content: { type: 'text'; text: string }[]; isError: boolean };

/**
 * The server, with its tools. `onCall` hears of every tool call, for the
 * audit trail.
 */
export function createBrainServer(version: string, onCall?: (called: Called, failed: boolean) => void): McpServer {
  const server = new McpServer({ name: 'second-brain', title: 'Second Brain', version }, { instructions: INSTRUCTIONS, capabilities: { tools: { listChanged: false } } });

  const run = async (tool: string, body: (called: Called) => Promise<string>): Promise<Text> => {
    const called: Called = { tool };
    try {
      const text = await body(called);
      onCall?.(called, false);
      return { content: [{ type: 'text', text }], isError: false };
    } catch (err) {
      onCall?.(called, true);
      // What the model can act on is said; anything else stays in the server's log.
      const known = err instanceof ToolError || err instanceof HttpError;
      if (!known) console.error('[mcp]', tool, err);
      return { content: [{ type: 'text', text: known ? err.message : 'That did not work on the server.' }], isError: true };
    }
  };

  const reads = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'list_brains',
    { title: 'List brains', description: 'The brains (knowledge bases) there are, with what each is about and how many pages it has. Start here when you do not know which brain to use.', annotations: reads },
    () =>
      run('list_brains', async () => {
        const brains = await listClusters();
        if (brains.length === 0) return 'There are no brains yet.';
        return brains.map((b) => `- ${b.name}: ${b.title}${b.scope ? `. ${b.scope}` : ''} (${b.pageCount} pages${b.updatedAt ? `, last changed ${b.updatedAt.slice(0, 10)}` : ''})`).join('\n');
      }),
  );

  server.registerTool(
    'search_brain',
    {
      title: 'Search a brain',
      description: 'Search the pages of a brain by words. Returns page titles, their paths and the line around the match. Use read_page to read one. Search a few ways (names, synonyms) when the first search finds little.',
      inputSchema: { brain: brainArg, query: z.string().min(1).max(200).describe('The words to look for.'), limit: z.number().int().min(1).max(30).optional().describe('At most this many pages (default 15).') },
      annotations: reads,
    },
    ({ brain, query, limit }) =>
      run('search_brain', async (called) => {
        const name = await brainOf(brain, called);
        const hits = await searchCluster(name, query.trim(), limit ?? 15);
        if (hits.length === 0) return `Nothing in ${name} matches "${query}".`;
        return hits.map((h) => `- ${h.title} (${h.slug})\n  ${h.snippet}`).join('\n');
      }),
  );

  server.registerTool(
    'read_page',
    {
      title: 'Read a page',
      description: 'Read one page of a brain in full: its properties, its text, the pages it links to and the pages that link to it. Name it by its title or its path. "index" is the brain\'s table of contents.',
      inputSchema: { brain: brainArg, page: z.string().min(1).max(300).describe('The page title (as in [[Title]]) or its path, e.g. "entities/warehouse-team" or "index".') },
      annotations: reads,
    },
    ({ brain, page }) =>
      run('read_page', async (called) => {
        const name = await brainOf(brain, called);
        const slug = await slugOf(name, page);
        called.page = slug;
        const [read, backlinks] = await Promise.all([readPage(name, slug), backlinksOf(name, slug)]);
        const props = read.properties.length ? `${read.properties.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n` : '';
        const linked = read.links.length ? `\n\nLinks to: ${[...new Set(read.links)].slice(0, 100).join(', ')}` : '';
        const linking = backlinks.length ? `\nLinked from: ${backlinks.slice(0, 100).map((b) => b.title).join(', ')}` : '';
        return `# ${read.title}\nPath: ${read.slug} · updated ${read.updatedAt.slice(0, 10)}\n\n${props}${clip(read.body.trim(), PAGE_MAX_CHARS)}${linked}${linking}`;
      }),
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'The pages of a brain, folder by folder (titles and paths). Give a folder to list only that one.',
      inputSchema: { brain: brainArg, folder: z.string().max(120).optional().describe('Only this folder, e.g. "entities".') },
      annotations: reads,
    },
    ({ brain, folder }) =>
      run('list_pages', async (called) => {
        const name = await brainOf(brain, called);
        const listing = await listPages(name);
        const only = (folder ?? '').trim().replace(/\/$/, '');
        const folders = listing.folders.filter((f) => !only || f.dir === only || f.dir.endsWith(`/${only}`));
        if (only && folders.length === 0) throw new ToolError(`There is no folder "${only}". There are: ${listing.folders.map((f) => f.dir).join(', ')}.`);
        const lines: string[] = [];
        if (!only && listing.root.length) lines.push(`## (top)\n${listing.root.map((p) => `- ${p.title} (${p.slug})`).join('\n')}`);
        for (const f of folders) lines.push(`## ${f.label} (${f.dir}), ${f.pages.length} pages\n${f.pages.map((p) => `- ${p.title} (${p.slug})`).join('\n')}`);
        return clip(`${listing.total} pages in ${name}.\n\n${lines.join('\n\n')}`, PAGE_MAX_CHARS);
      }),
  );

  server.registerTool(
    'recent_changes',
    {
      title: 'Recent changes',
      description: 'What was filed or changed in a brain lately, newest first, from its log: what came in and which pages it touched.',
      inputSchema: { brain: brainArg, limit: z.number().int().min(1).max(50).optional().describe('At most this many entries (default 15).') },
      annotations: reads,
    },
    ({ brain, limit }) =>
      run('recent_changes', async (called) => {
        const name = await brainOf(brain, called);
        const entries = await readLog(name, limit ?? 15);
        if (entries.length === 0) return `Nothing has been logged in ${name} yet.`;
        return entries.map((e) => `- ${e.when} · ${e.action} · ${e.subject}${e.details.length ? `\n${e.details.slice(0, 8).map((d) => `  ${d}`).join('\n')}` : ''}`).join('\n');
      }),
  );

  server.registerTool(
    'file_document',
    {
      title: 'File a document into the brain',
      description:
        'Send a document to be filed into a brain: the full text of something the user pasted or attached (a contract, notes, a report, an email). The brain plans and files it itself, with its own rules, at once: it creates or updates the pages it concerns and links them. The same text sent twice is filed once. Every filing can be undone in the app. Only file what the user asked you to file. Afterwards, filing_status says what it changed.',
      inputSchema: {
        brain: brainArg,
        title: z.string().min(1).max(200).describe('A short title for the document, e.g. "Q3 board pack" or "Call with the lender, 14 Oct".'),
        text: z.string().min(1).max(1_000_000).describe('The whole text of the document, as it is. Not a summary.'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('The date the document is from, YYYY-MM-DD, when known.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ brain, title, text, date }) =>
      run('file_document', async (called) => {
        const name = await brainOf(brain, called);
        const cleanTitle = title.replace(/\s+/g, ' ').trim();
        const body = text.replace(/\r\n/g, '\n').trim();
        if (!cleanTitle || !body) throw new ToolError('Give the document a title and its text.');
        ensureIngestWorker();
        const sent = await enqueue({ cluster: name, title: cleanTitle, text: body, sourceId: sourceIdFor(name, cleanTitle, body), kind: 'document', date: date ?? null });
        called.page = sent.id;
        if (sent.status === 'duplicate') return `This document was sent before (${sent.id}), so it is not filed again. filing_status with that id says what it did.`;
        called.wrote = true;
        return `Sent in to be filed into ${name} as ${sent.id}${sent.position && sent.position > 1 ? ` (${sent.position - 1} ahead of it)` : ''}. The brain plans and files it now; it usually takes a minute or two. Ask filing_status with this id to see what it changed.`;
      }),
  );

  server.registerTool(
    'filing_status',
    {
      title: 'Filing status',
      description: 'What happened to documents sent in with file_document: waiting, being filed, filed (with the pages it created or updated) or failed. Give the id file_document returned, or leave it out for the latest few in a brain.',
      inputSchema: { brain: brainArg, id: z.string().uuid().optional().describe('The id file_document returned.') },
      annotations: reads,
    },
    ({ brain, id }) =>
      run('filing_status', async (called) => {
        if (id) {
          const item = await readItem(id);
          if (!item) throw new ToolError(`Nothing was sent in as ${id}.`);
          called.brain = item.cluster;
          return statusOf(item);
        }
        const name = await brainOf(brain, called);
        const items = (await listItems(name)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, STATUS_ITEMS);
        if (items.length === 0) return `No documents have been sent in to ${name}.`;
        return (await Promise.all(items.map(statusOf))).join('\n');
      }),
  );

  return server;
}
