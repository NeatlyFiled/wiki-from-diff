// The wiki's CI endpoints, from the workflow's side: which wiki, the GitHub
// OIDC token that proves which repository is asking, recording the push and
// getting a CI token for the job's own agent. The repository holds no keys.

/** A bare `wiki` input is a subdomain of this. */
export const DOMAIN = 'neatlyfiled.com';

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

/** `POST /api/ci/pushes`'s answer; `stale`: pages whose frontmatter `covers:` matched files the push changed (older wikis leave it out). */
export type Recorded = { revision: number; page: string; url: string; repeated: boolean; stale?: { path: string; title: string; url: string; files: string[] }[] };
/** `POST /api/ci/token`'s answer; `write_paths` echoes the folders the token is limited to. */
export type CiToken = { token: string; expires_at: string; write_paths?: string[]; mcp_url: string; api_url: string; wiki_url: string };

export type ClientOptions = {
  origin: string;
  /** A fresh OIDC token for each request. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
};

export class CiClient {
  #options: ClientOptions;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  async #post<T>(route: string, body: unknown): Promise<T> {
    const response = await (this.#options.fetch ?? fetch)(`${this.#options.origin}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.#options.token()}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (response.ok && data) return data as T;
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error; // the wiki's error shape
    throw new ApiError(response.status, error?.code ?? 'http_error', error?.message ?? `POST ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  }

  /** Records the push as a wiki page, or returns the page an earlier run recorded. */
  record(push: unknown): Promise<Recorded> {
    return this.#post('/api/ci/pushes', push);
  }

  /** A short-lived write token for this wiki, with its MCP and API addresses; `writePaths` limits where it may write. */
  ciToken(writePaths: string[] = []): Promise<CiToken> {
    return this.#post('/api/ci/token', writePaths.length ? { write_paths: writePaths } : {});
  }
}
