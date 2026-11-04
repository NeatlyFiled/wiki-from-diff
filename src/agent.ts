// The agent: a Claude tool-use loop over the Anthropic Messages API. Its tools
// mirror the wiki's MCP tools, except that writes go to `Staging` and are only
// sent, as one revision, once the agent is done.
import { ApiError, sleep, Staging, type Wiki } from './wiki.ts';

/** The default model; override with the `model` input. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

/** Model turns per run; the agent is asked to wrap up when they run out. */
export const MAX_TURNS = 30;
/** Longest tool result handed back to the model, in characters. */
const MAX_TOOL_OUTPUT = 30_000;
const MAX_TOKENS = 16_000;
const API_RETRIES = 4;

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: { type: 'ephemeral' } };
export type Message = { role: 'user' | 'assistant'; content: Block[] };
type Response = { content: Block[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } };

// From the wiki's MCP RULES (apps/web/src/pages/mcp.ts), minus revisions: this
// run sends one revision itself, so the tools take no base.
const WIKI_RULES = `Paths are relative file paths such as "guides/setup.md"; pages end in .md.
Links to pages that do not exist yet are fine: they are red links. A link to a missing attachment or an ambiguous [[wikilink]] fails with "broken_links" (details.links lists path, line, target and reason). Moves rewrite other pages' links to follow the page.`;

const path = { type: 'string', description: 'File path, e.g. "guides/setup.md"' };

export const TOOLS = [
  {
    name: 'search',
    description: 'Full-text search over page titles and text. Every word must match; the last word also matches as a prefix. Returns path, title and a snippet with matches wrapped in **. Read a hit with read_page. Does not see edits staged in this run.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum results (default 20)' } }, required: ['query'] },
  },
  {
    name: 'list_pages',
    description: 'Lists pages, optionally only those whose path starts with prefix (e.g. "guides/"). Pages created in this run are marked staged.',
    input_schema: { type: 'object', properties: { prefix: { type: 'string', description: 'Only paths starting with this, e.g. "guides/"' } } },
  },
  {
    name: 'read_page',
    description: "Reads a page's Markdown source, with your staged edits applied. The first block is JSON metadata (title, backlinks: pages linking here); the second is the Markdown.",
    input_schema: { type: 'object', properties: { path }, required: ['path'] },
  },
  {
    name: 'write_page',
    description: 'Creates a page, or replaces a whole page. Staged: sent with your other edits as one revision when you finish. To change one section without sending the whole page, use edit_section.',
    input_schema: { type: 'object', properties: { path, content: { type: 'string', description: 'The full Markdown text of the page' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit_section',
    description:
      'Changes one section of an existing page. section is the heading text (case-insensitive, "#" optional). mode "replace" swaps the section\'s body (keeping its heading); "append" adds content to the end of the section, or to the end of the page when section is omitted. Fails with "no_section" or "ambiguous_section" if the heading is not found or appears twice. Staged like write_page.',
    input_schema: {
      type: 'object',
      properties: {
        path,
        section: { type: 'string', description: 'Heading text of the section; omit to append to the end of the page' },
        mode: { type: 'string', enum: ['replace', 'append'] },
        content: { type: 'string', description: 'Markdown for the section body (without its heading)' },
      },
      required: ['path', 'mode', 'content'],
    },
  },
  {
    name: 'move_page',
    description: 'Moves (renames) a page; links in other pages are rewritten to follow it. Use only when the code change renames the concept the page documents. Staged like write_page.',
    input_schema: { type: 'object', properties: { from: path, to: path }, required: ['from', 'to'] },
  },
];

export function systemPrompt(options: { repo: string; folder?: string; instructions?: string }): string {
  const { repo, folder, instructions } = options;
  return [
    `You maintain the engineering wiki for the code repository ${repo}. A push just landed; you get its commits and diff. Update the wiki pages that describe behavior the push changes: APIs, configuration, architecture, data models, runbooks, setup steps.`,
    '',
    'How to work:',
    '- Find the pages that cover the changed code (list_pages, search, read_page) and read a page before editing it.',
    '- Prefer edit_section for changes to part of a page; use write_page for new pages or rewrites of short pages.',
    "- Keep each page's existing structure, tone and formatting. Never delete content unrelated to the change.",
    `- Create a page only for a genuinely new concept that no page covers${folder ? `, under "${folder.replace(/\/+$/, '')}/"` : ''}, and link to it from a related page.`,
    "- Do not document trivial refactors, formatting, test-only or dependency-bump changes. Document only what the diff shows; don't guess at code you cannot see.",
    '- If nothing needs updating, say so and make no edits.',
    '- Your edits are staged and saved as one wiki revision when you finish; nothing is written before then.',
    '',
    'When you are done, reply with a summary of what you changed in the wiki: a first line under 72 characters (no Markdown), then optionally a short bullet list.',
    ...(folder ? ['', `Scope: this repository's pages live under "${folder.replace(/\/+$/, '')}/"; look there first.`] : []),
    '',
    'Wiki rules:',
    WIKI_RULES,
    ...(instructions?.trim() ? ['', 'Instructions from the repository owner:', instructions.trim()] : []),
  ].join('\n');
}

/** `"/guides/setup.md "` -> `"guides/setup.md"`; rejects what the wiki would. */
export function cleanPath(input: unknown): string {
  const file = String(input ?? '')
    .trim()
    .replace(/^\/+/, '');
  if (!file || file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ApiError(400, 'invalid_path', `invalid path "${String(input)}"`);
  }
  if (!file.endsWith('.md')) throw new ApiError(400, 'invalid_path', `pages end in .md: "${file}"`);
  return file;
}

/** Runs one tool call; failures become `{error}` results the model can act on. */
export async function runTool(name: string, input: Record<string, unknown>, wiki: Pick<Wiki, 'search'>, staging: Staging): Promise<{ content: string; isError?: boolean }> {
  const json = (data: unknown) => ({ content: JSON.stringify(data, null, 2) });
  try {
    switch (name) {
      case 'search':
        return json(await wiki.search(String(input.query ?? ''), Math.min(Number(input.limit) || 20, 100)));
      case 'list_pages': {
        const { pages } = await staging.list(typeof input.prefix === 'string' ? input.prefix : '');
        return json({ pages });
      }
      case 'read_page': {
        const { content, head: _head, revision: _revision, ...meta } = await staging.read(cleanPath(input.path));
        return { content: `${JSON.stringify(meta, null, 2)}\n\n${content}` };
      }
      case 'write_page':
        staging.put(cleanPath(input.path), String(input.content ?? ''));
        return json({ staged: true });
      case 'edit_section': {
        const mode = input.mode === 'replace' ? 'replace' : 'append';
        await staging.patch(cleanPath(input.path), typeof input.section === 'string' ? input.section : undefined, mode, String(input.content ?? ''));
        return json({ staged: true });
      }
      case 'move_page':
        await staging.move(cleanPath(input.from), cleanPath(input.to));
        return json({ staged: true });
      default:
        throw new ApiError(400, 'unknown_tool', `no tool named ${name}`);
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { content: JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2), isError: true };
  }
}

export type AgentOptions = {
  apiKey: string;
  model: string;
  baseUrl: string;
  system: string;
  wiki: Pick<Wiki, 'search'>;
  staging: Staging;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

/**
 * Continues `messages` (ending with a user turn) until the model stops
 * calling tools or `turns` run out, then returns its closing text.
 */
export async function converse(messages: Message[], turns: number, options: AgentOptions): Promise<string> {
  const log = options.log ?? console.log;
  for (let turn = 1; ; turn++) {
    const last = turn >= turns;
    if (last) appendText(messages, 'You have reached the step limit. Stop calling tools and reply with your summary of the edits you made.');
    const response = await callModel(messages, options, last);
    messages.push({ role: 'assistant', content: response.content });
    const calls = response.content.filter((block): block is Extract<Block, { type: 'tool_use' }> => block.type === 'tool_use');
    if (!calls.length || last) return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
    const results: Block[] = [];
    for (const call of calls) {
      const result = await runTool(call.name, call.input ?? {}, options.wiki, options.staging);
      log(`${result.isError ? '✗' : '✓'} ${call.name} ${JSON.stringify(call.input).slice(0, 160)}`);
      const content = result.content.length > MAX_TOOL_OUTPUT ? `${result.content.slice(0, MAX_TOOL_OUTPUT)}\n[… cut: ${result.content.length} characters in all]` : result.content;
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(result.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
}

/** Adds text to the last (user) message, or starts a new user message. */
export function appendText(messages: Message[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

async function callModel(messages: Message[], options: AgentOptions, noTools: boolean): Promise<Response> {
  const tools = TOOLS.map((tool, i) => (i === TOOLS.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool));
  // Cache the conversation so far: the latest user turn is the moving breakpoint.
  const sent = messages.map((message, i) =>
    i === messages.length - 1 ? { ...message, content: message.content.map((block, j) => (j === message.content.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block)) } : message,
  );
  const body = { model: options.model, max_tokens: MAX_TOKENS, system: options.system, tools, messages: sent, ...(noTools ? { tool_choice: { type: 'none' } } : {}) };
  for (let attempt = 0; ; attempt++) {
    const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) {
      const result = JSON.parse(text) as Response;
      const usage = result.usage;
      if (usage) (options.log ?? console.log)(`model: ${usage.input_tokens} input (+${usage.cache_read_input_tokens ?? 0} cached), ${usage.output_tokens} output tokens`);
      return result;
    }
    // 429 rate limited, 5xx and 529 overloaded are worth waiting out.
    if ((response.status === 429 || response.status >= 500) && attempt < API_RETRIES) {
      const seconds = Number(response.headers.get('retry-after')) || 5 * 2 ** attempt;
      (options.log ?? console.log)(`Anthropic API answered ${response.status}; retrying in ${seconds}s`);
      await sleep(seconds * 1000);
      continue;
    }
    throw new Error(`Anthropic API answered ${response.status}: ${text.slice(0, 500)}`);
  }
}
