// The wiki's JSON API, and the staging area the agent writes to: edits are
// kept in memory (reads see them) and sent as one revision at the end.

/** An error answer from the wiki: `{error: {code, message, details}}` with its HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type PageEntry = { path: string; url: string; title: string; revision: number };
export type Page = { head?: number; path: string; url?: string; title?: string; content: string; revision?: number; backlinks?: { path: string }[] };
export type Change =
  | { op: 'put'; path: string; content: string }
  | { op: 'patch'; path: string; section?: string; mode: 'replace' | 'append'; content: string }
  | { op: 'move'; from: string; to: string };
export type CommitResult = { head: number; revision: number; repeated: boolean; merged: string[]; rewritten: string[]; wanted: unknown[] };

/** How many times a rate-limited request is retried before giving up. */
const RATE_LIMIT_RETRIES = 5;

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const pageRoute = (file: string) => `/api/pages/${file.split('/').map(encodeURIComponent).join('/')}`;

export class Wiki {
  readonly url: string;
  #token: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;

  constructor(url: string, token: string, options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? sleep;
  }

  /** Sends a request, waiting out `429 rate_limited` (Retry-After) and throwing `ApiError` for other failures. */
  async request<T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(`${this.url}${route}`, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      if (response.ok) return data as T;
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const seconds = Number(response.headers.get('retry-after')) || 10;
        console.log(`Wiki rate limit reached; retrying in ${seconds}s`);
        await this.#sleep(seconds * 1000);
        continue;
      }
      const error = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error; // the wiki's error shape
      throw new ApiError(response.status, error?.code ?? 'http_error', error?.message ?? `${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`, error?.details);
    }
  }

  listPages(prefix = ''): Promise<{ head: number; pages: PageEntry[] }> {
    return this.request('GET', `/api/pages${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`);
  }

  readPage(file: string): Promise<Page> {
    return this.request('GET', pageRoute(file));
  }

  search(query: string, limit = 20): Promise<{ results: { path: string; title: string; snippet: string }[] }> {
    return this.request('GET', `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /** One revision; repeating `key` returns the first result instead of writing again. */
  commit(request: { base: number; message: string; changes: Change[] }, key: string): Promise<CommitResult> {
    return this.request('POST', '/api/changes', request, { 'idempotency-key': key });
  }
}

/** The page reads `Staging` needs; a `Wiki` in production, a fake in tests. */
export type Reader = Pick<Wiki, 'readPage' | 'listPages'>;

/**
 * Edits the agent made, not yet sent. Reads go through it so the agent sees
 * its own edits; `changes` is the request body, in order, with puts replacing
 * earlier edits of the same page.
 */
export class Staging {
  readonly changes: Change[] = [];
  /** Path -> its staged text, or null once moved away. */
  #pages = new Map<string, string | null>();
  #wiki: Reader;

  constructor(wiki: Reader) {
    this.#wiki = wiki;
  }

  /** The page's text with staged edits, or undefined if it does not exist. */
  async text(file: string): Promise<string | undefined> {
    if (this.#pages.has(file)) return this.#pages.get(file) ?? undefined;
    try {
      return (await this.#wiki.readPage(file)).content;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `read_page`: the wiki's answer, or the staged text marked `staged`. */
  async read(file: string): Promise<Page & { staged?: boolean }> {
    if (!this.#pages.has(file)) return this.#wiki.readPage(file);
    const content = this.#pages.get(file);
    if (content == null) throw new ApiError(404, 'not_found', `${file} was moved away in this run`);
    return { path: file, content, staged: true };
  }

  /** `list_pages`: the wiki's list with staged pages added and moved ones removed. */
  async list(prefix = ''): Promise<{ pages: (PageEntry | { path: string; staged: true })[] }> {
    const { pages } = await this.#wiki.listPages(prefix);
    const listed: (PageEntry | { path: string; staged: true })[] = pages.filter((page) => this.#pages.get(page.path) !== null);
    for (const [file, content] of this.#pages) {
      if (content !== null && file.startsWith(prefix) && !pages.some((page) => page.path === file)) listed.push({ path: file, staged: true });
    }
    return { pages: listed };
  }

  put(file: string, content: string): void {
    // A put replaces the page, so earlier edits of it (since it last moved) are dropped.
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const change = this.changes[i];
      if (change.op === 'move' && (change.from === file || change.to === file)) break;
      if (change.op !== 'move' && change.path === file) this.changes.splice(i, 1);
    }
    this.changes.push({ op: 'put', path: file, content });
    this.#pages.set(file, content);
  }

  async patch(file: string, section: string | undefined, mode: 'replace' | 'append', content: string): Promise<void> {
    const current = await this.text(file);
    if (current === undefined) throw new ApiError(404, 'not_found', `${file} does not exist; create it with write_page`);
    const next = patchSection(current, { section, mode, content });
    this.changes.push({ op: 'patch', path: file, section, mode, content });
    this.#pages.set(file, next);
  }

  async move(from: string, to: string): Promise<void> {
    if (from === to) throw new ApiError(400, 'invalid_move', 'from and to are the same');
    const content = await this.text(from);
    if (content === undefined) throw new ApiError(404, 'not_found', `${from} does not exist`);
    if ((await this.text(to)) !== undefined) throw new ApiError(409, 'exists', `${to} already exists`);
    this.changes.push({ op: 'move', from, to });
    this.#pages.set(to, content);
    this.#pages.set(from, null);
  }

  /** Where each edited page ends up, and the pages moved (from -> to). */
  summary(): { pages: string[]; moves: [string, string][] } {
    const pages = new Set<string>();
    const moves: [string, string][] = [];
    for (const change of this.changes) {
      if (change.op !== 'move') pages.add(change.path);
      else {
        pages.delete(change.from);
        pages.add(change.to);
        moves.push([change.from, change.to]);
      }
    }
    return { pages: [...pages], moves };
  }
}

/**
 * The wiki's section edit (packages/store/src/sections.ts), so reads after an
 * `edit_section` show the result. Headings are ATX (`#`) lines outside code
 * fences; the wiki applies the real edit when the revision is sent.
 */
export function patchSection(text: string, { section, mode, content }: { section?: string; mode: 'replace' | 'append'; content: string }): string {
  const body = content.trim();
  if (section === undefined || section.trim() === '') {
    if (mode !== 'append') throw new ApiError(400, 'invalid_patch', 'replacing needs a section; to replace the whole page, use write_page');
    return `${text.trimEnd()}\n\n${body}\n`;
  }
  const wanted = section.replace(/^#+\s*/, '').trim().toLowerCase();
  const headings: { depth: number; title: string; start: number; end: number }[] = [];
  let fence: string | undefined;
  let offset = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? undefined : marker;
    else if (!fence) {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (heading) headings.push({ depth: heading[1].length, title: (heading[2] ?? '').replace(/[*_`]/g, '').trim().toLowerCase(), start: offset, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  const matches = headings.filter((heading) => heading.title === wanted);
  if (!matches.length) throw new ApiError(404, 'no_section', `no section headed "${section}"`);
  if (matches.length > 1) throw new ApiError(409, 'ambiguous_section', `${matches.length} sections are headed "${section}"`);
  const [heading] = matches;
  const next = headings.find((other) => other.start > heading.start && other.depth <= heading.depth);
  const end = next ? next.start : text.length;
  const rest = end < text.length ? `\n${text.slice(end)}` : '';
  if (mode === 'replace') return `${text.slice(0, heading.end)}\n\n${body}\n${rest}`;
  return `${text.slice(0, end).trimEnd()}\n\n${body}\n${rest}`;
}

/** The revision for a push: its message, and the key that makes reruns return the first result. */
export function commitRequest(options: { repo: string; sha: string; serverUrl: string; base: number; summary: string; changes: Change[] }) {
  const { repo, sha, serverUrl, base, summary, changes } = options;
  // The summary's first line heads the message; the rest is its body.
  const [first = '', ...rest] = summary.trim().split('\n');
  const headline = first.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim() || 'update pages for the pushed changes';
  const title = `Docs for ${repo}@${sha.slice(0, 7)}: ${clip(headline, 100)}`;
  const message = `${title}\n\n${rest.join('\n').trim()}\n\n${serverUrl}/${repo}/commit/${sha}`.replace(/\n{3,}/g, '\n\n');
  return { body: { base, message, changes }, key: `${repo}@${sha}` };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
