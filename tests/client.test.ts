import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, CiClient, oidcToken, wikiOrigin, type Run } from '../src/client.ts';

test('the wiki input: a subdomain or an https address', () => {
  assert.equal(wikiOrigin('acme'), 'https://acme.neatlyfiled.com');
  assert.equal(wikiOrigin(' Acme-Docs '), 'https://acme-docs.neatlyfiled.com');
  assert.equal(wikiOrigin('https://acme.neatlyfiled.com/some/page'), 'https://acme.neatlyfiled.com');
  assert.equal(wikiOrigin('http://acme.localhost:4371'), 'http://acme.localhost:4371');
  assert.throws(() => wikiOrigin('http://acme.example.com'), /https address/);
  assert.throws(() => wikiOrigin('acme corp'), /subdomain/);
});

test('the OIDC token is requested for the wiki, and its absence explains the permission', async () => {
  await assert.rejects(oidcToken('https://acme.neatlyfiled.com', {}), /permissions: id-token: write/);
  const seen: { url: string; authorization: string }[] = [];
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), authorization: (init.headers as Record<string, string>).authorization });
    return Response.json({ value: 'jwt' });
  }) as unknown as typeof fetch;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.example/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime' };
  assert.equal(await oidcToken('https://acme.neatlyfiled.com', env, fakeFetch), 'jwt');
  assert.deepEqual(seen, [{ url: 'https://pipelines.example/token?api-version=2.0&audience=https%3A%2F%2Facme.neatlyfiled.com', authorization: 'bearer runtime' }]);
});

test('start posts the push with a fresh token; wait polls with backoff until the run is done', async () => {
  const requests: { method: string; url: string; authorization: string; body?: unknown }[] = [];
  const answers: Run[] = [{ id: 'r1', status: 'running' }, { id: 'r1', status: 'running' }, { id: 'r1', status: 'saved', revision: 7, pages: ['a.md'] }];
  let tokens = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ method: init.method!, url, authorization: (init.headers as Record<string, string>).authorization, body: init.body && JSON.parse(String(init.body)) });
    if (requests.length === 3) return new Response('bad gateway', { status: 502 }); // a hiccup while polling is retried
    return Response.json(answers.shift(), { status: requests.length === 1 ? 202 : 200 });
  }) as typeof fetch;
  const waits: number[] = [];
  const client = new CiClient({ origin: 'https://acme.neatlyfiled.com', token: async () => `jwt${++tokens}`, fetch: fakeFetch, sleep: async (ms) => void waits.push(ms) });
  const started = await client.start({ sha: 'abc' });
  const done = await client.wait(started);
  assert.equal(done.revision, 7);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url} ${request.authorization}`), [
    'POST https://acme.neatlyfiled.com/api/ci/runs Bearer jwt1',
    'GET https://acme.neatlyfiled.com/api/ci/runs/r1 Bearer jwt2',
    'GET https://acme.neatlyfiled.com/api/ci/runs/r1 Bearer jwt3',
    'GET https://acme.neatlyfiled.com/api/ci/runs/r1 Bearer jwt4',
  ]);
  assert.deepEqual(requests[0].body, { sha: 'abc' });
  assert.deepEqual(waits, [2000, 3000, 4500]);
});

test('the wiki refusing is an error with its code; a run that never ends times out', async () => {
  const refuse = (async () => Response.json({ error: { code: 'repository_not_connected', message: 'acme/api is not connected' } }, { status: 403 })) as unknown as typeof fetch;
  const client = new CiClient({ origin: 'https://w', token: async () => 't', fetch: refuse });
  await assert.rejects(client.start({}), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'repository_not_connected');

  let clock = 0;
  const running = (async () => Response.json({ id: 'r', status: 'running' })) as unknown as typeof fetch;
  const slow = new CiClient({ origin: 'https://w', token: async () => 't', fetch: running, now: () => clock, sleep: async (ms) => void (clock += ms) });
  await assert.rejects(slow.wait({ id: 'r', status: 'running' }, 60_000), /still going after 1 minutes/);
});
