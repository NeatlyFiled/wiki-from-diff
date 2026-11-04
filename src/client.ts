// The wiki's CI endpoints, from the workflow's side: which wiki, the GitHub
// OIDC token that proves which repository is asking, and the run to start and
// poll. The wiki runs the agent; the repository holds no keys.

/** A bare `wiki` input is a subdomain of this. */
export const DOMAIN = 'neatlyfiled.com';
/** How long to wait for a run before giving up on it (the wiki still finishes it). */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** `acme` -> `https://acme.neatlyfiled.com`; a full address is kept (https, or http on localhost for testing). */
export function wikiOrigin(input: string): string {
  const value = input.trim();
  if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)) return `https://${value.toLowerCase()}.${DOMAIN}`;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const local = url?.protocol === 'http:' && /(^|\.)localhost$|^127\.0\.0\.1$/.test(url.hostname);
  if (!url || (url.protocol !== 'https:' && !local)) {
    throw new Error(`"wiki" is your wiki's subdomain (acme) or its https address (https://acme.${DOMAIN}), not "${input}"`);
  }
  return url.origin;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A GitHub OIDC token for `audience`, from the variables GitHub sets when the job has `id-token: write`. */
export async function oidcToken(audience: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) throw new Error('GitHub gave this job no OIDC token: add "permissions: id-token: write" to the job (and "contents: read")');
  const request = new URL(url);
  request.searchParams.set('audience', audience);
  const response = await fetchImpl(request, { headers: { authorization: `bearer ${token}`, accept: 'application/json' } });
  if (!response.ok) throw new Error(`GitHub refused an OIDC token (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const { value } = (await response.json()) as { value?: string };
  if (!value) throw new Error('GitHub answered without an OIDC token');
  return value;
}

export type Run = {
  id: string;
  status: 'running' | 'saved' | 'unchanged' | 'planned' | 'failed';
  summary?: string;
  revision?: number;
  revisionUrl?: string;
  repeated?: boolean;
  pages?: string[];
  moves?: [string, string][];
  plan?: unknown;
  error?: { code: string; message: string };
  usage?: { inputTokens: number; outputTokens: number };
};

export type ClientOptions = {
  origin: string;
  /** A fresh OIDC token for each request: they last minutes, runs can take longer. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

export class CiClient {
  #options: ClientOptions;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  async #request(method: string, route: string, body?: unknown): Promise<Run> {
    const response = await (this.#options.fetch ?? fetch)(`${this.#options.origin}${route}`, {
      method,
      headers: { authorization: `Bearer ${await this.#options.token()}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (response.ok && data) return data as Run;
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error; // the wiki's error shape
    throw new ApiError(response.status, error?.code ?? 'http_error', error?.message ?? `${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  }

  /** Starts documenting the push, or returns the run (or revision) the wiki already has for it. */
  start(payload: unknown): Promise<Run> {
    return this.#request('POST', '/api/ci/runs', payload);
  }

  /** Polls until the run is done, backing off from 2 to 15 seconds; network and 5xx hiccups are retried. */
  async wait(run: Run, timeoutMs = RUN_TIMEOUT_MS): Promise<Run> {
    const { sleep = defaultSleep, now = Date.now, log = () => {} } = this.#options;
    const deadline = now() + timeoutMs;
    let delay = 2000;
    while (run.status === 'running') {
      if (now() >= deadline) throw new Error(`the run was still going after ${Math.round(timeoutMs / 60_000)} minutes; the wiki finishes it on its own (see Admin → Connected repositories)`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 15_000);
      try {
        run = await this.#request('GET', `/api/ci/runs/${encodeURIComponent(run.id)}`);
      } catch (error) {
        if (error instanceof ApiError && error.status < 500 && error.status !== 429) throw error;
        log(`polling failed (${error instanceof Error ? error.message : String(error)}); retrying`);
      }
    }
    return run;
  }
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
