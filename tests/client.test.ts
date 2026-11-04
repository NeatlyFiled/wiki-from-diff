import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, CiClient, oidcToken, wikiOrigin } from '../src/client.ts';

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

test('record and ciToken post to the wiki with a fresh OIDC token each', async () => {
  const requests: { method: string; url: string; authorization: string; body?: unknown }[] = [];
  const answers = [
    { status: 201, body: { revision: 7, page: 'changes/api/2026/11/2026-11-04-abc1234.md', url: 'https://acme.neatlyfiled.com/changes/api/2026/11/2026-11-04-abc1234/', repeated: false } },
    { status: 201, body: { token: 'awc_x.y', expires_at: '2026-11-04T13:00:00.000Z', mcp_url: 'https://acme.neatlyfiled.com/mcp', api_url: 'https://acme.neatlyfiled.com/api', wiki_url: 'https://acme.neatlyfiled.com/' } },
  ];
  let tokens = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ method: init.method!, url, authorization: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
    const answer = answers.shift()!;
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
  const client = new CiClient({ origin: 'https://acme.neatlyfiled.com', token: async () => `jwt${++tokens}`, fetch: fakeFetch });
  assert.equal((await client.record({ sha: 'abc' })).revision, 7);
  assert.equal((await client.ciToken()).token, 'awc_x.y');
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url} ${request.authorization}`), [
    'POST https://acme.neatlyfiled.com/api/ci/pushes Bearer jwt1',
    'POST https://acme.neatlyfiled.com/api/ci/token Bearer jwt2',
  ]);
  assert.deepEqual(requests[0].body, { sha: 'abc' });
});

test('the wiki refusing is an error with its code', async () => {
  const refuse = (async () => Response.json({ error: { code: 'repository_not_connected', message: 'acme/api is not connected' } }, { status: 403 })) as unknown as typeof fetch;
  const client = new CiClient({ origin: 'https://w', token: async () => 't', fetch: refuse });
  await assert.rejects(client.record({}), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'repository_not_connected');
  const broken = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(new CiClient({ origin: 'https://w', token: async () => 't', fetch: broken }).ciToken(), /answered 502: bad gateway/);
});
