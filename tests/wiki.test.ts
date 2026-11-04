import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTool } from '../src/agent.ts';
import { ApiError, commitRequest, patchSection, Staging, Wiki, type Reader } from '../src/wiki.ts';

/** A wiki with these pages that counts reads. */
function fakeWiki(pages: Record<string, string>) {
  const reads: string[] = [];
  const wiki: Reader = {
    async readPage(file) {
      reads.push(file);
      if (!(file in pages)) throw new ApiError(404, 'not_found', `${file} does not exist`);
      return { head: 7, path: file, content: pages[file], revision: 3 };
    },
    async listPages(prefix = '') {
      return { head: 7, pages: Object.keys(pages).filter((file) => file.startsWith(prefix)).map((file) => ({ path: file, url: `/${file.slice(0, -3)}/`, title: file, revision: 3 })) };
    },
  };
  return { wiki, reads };
}

const API = '# API\n\nIntro.\n\n## Auth\n\nTokens.\n\n```md\n## Auth\n```\n\n## Limits\n\n60 a minute.\n';

test('reads see staged edits; nothing is sent while staging', async () => {
  const { wiki, reads } = fakeWiki({ 'api.md': API });
  const staging = new Staging(wiki);
  await staging.patch('api.md', 'limits', 'replace', '300 a minute.');
  assert.match((await staging.read('api.md')).content, /## Limits\n\n300 a minute\.\n$/);
  assert.equal((await staging.read('api.md')).staged, true);
  staging.put('new.md', '# New\n');
  assert.equal((await staging.read('new.md')).content, '# New\n');
  assert.deepEqual(
    (await staging.list()).pages.map((page) => page.path),
    ['api.md', 'new.md'],
  );
  assert.deepEqual(reads, ['api.md'], 'the page is fetched once, then read from staging');
});

test('a put replaces earlier edits of the page; a patch after a put applies to the staged text', async () => {
  const { wiki } = fakeWiki({ 'api.md': API });
  const staging = new Staging(wiki);
  await staging.patch('api.md', 'Auth', 'append', 'Rotate yearly.');
  staging.put('api.md', '# API\n\n## Limits\n\nNone.\n');
  assert.deepEqual(staging.changes, [{ op: 'put', path: 'api.md', content: '# API\n\n## Limits\n\nNone.\n' }]);
  await staging.patch('api.md', 'Limits', 'replace', 'Some.');
  assert.equal(staging.changes.length, 2);
  assert.equal((await staging.read('api.md')).content, '# API\n\n## Limits\n\nSome.\n');
});

test('moves: the old path is gone, the new one has the text, and earlier edits follow the page', async () => {
  const { wiki } = fakeWiki({ 'api.md': API, 'other.md': '# Other\n' });
  const staging = new Staging(wiki);
  await staging.patch('api.md', 'Auth', 'append', 'Rotate yearly.');
  await staging.move('api.md', 'reference/api.md');
  await assert.rejects(staging.read('api.md'), /moved away/);
  assert.match((await staging.read('reference/api.md')).content, /Rotate yearly\./);
  await assert.rejects(staging.move('other.md', 'reference/api.md'), /already exists/);
  staging.put('api.md', '# Fresh\n'); // a new page at the old path keeps the earlier patch, which moved with the page
  assert.deepEqual(staging.changes.map((change) => change.op), ['patch', 'move', 'put']);
  assert.deepEqual(staging.summary(), { pages: ['reference/api.md', 'api.md'], moves: [['api.md', 'reference/api.md']] });
});

test('section edits match the wiki: headings in code fences do not count, missing ones fail', () => {
  assert.equal(patchSection(API, { section: '## Auth', mode: 'replace', content: 'Keys.' }), '# API\n\nIntro.\n\n## Auth\n\nKeys.\n\n## Limits\n\n60 a minute.\n');
  assert.equal(patchSection('# A\n', { mode: 'append', content: 'More.' }), '# A\n\nMore.\n');
  assert.throws(() => patchSection(API, { section: 'Nope', mode: 'append', content: 'x' }), /no section/);
  assert.throws(() => patchSection('## X\n\n## X\n', { section: 'X', mode: 'append', content: 'x' }), /2 sections/);
});

test('tool errors go back to the model; bad paths are rejected before staging', async () => {
  const { wiki } = fakeWiki({ 'api.md': API });
  const staging = new Staging(wiki);
  const search = { search: async () => ({ results: [] }) };
  const missing = await runTool('edit_section', { path: 'gone.md', mode: 'append', content: 'x' }, search, staging);
  assert.equal(missing.isError, true);
  assert.equal(JSON.parse(missing.content).error.code, 'not_found');
  assert.equal((await runTool('write_page', { path: '../x.md', content: '' }, search, staging)).isError, true);
  assert.equal((await runTool('write_page', { path: '/guides/x.md', content: '# X\n' }, search, staging)).isError, undefined);
  assert.deepEqual(staging.changes, [{ op: 'put', path: 'guides/x.md', content: '# X\n' }]);
});

test('the revision request: base, idempotency key, message with the commit link', async () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const changes = [{ op: 'put' as const, path: 'a.md', content: '# A\n' }];
  const { body, key } = commitRequest({ repo: 'acme/api', sha, serverUrl: 'https://github.com', base: 41, summary: '## Updated rate limits\n\n- api.md: new limit', changes });
  assert.equal(key, `acme/api@${sha}`);
  assert.equal(body.message, `Docs for acme/api@abcdef0: Updated rate limits\n\n- api.md: new limit\n\nhttps://github.com/acme/api/commit/${sha}`);
  assert.equal(body.base, 41);

  const sent: { url: string; init: RequestInit }[] = [];
  let calls = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    if (calls++ === 0) return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'wait' } }), { status: 429, headers: { 'retry-after': '2' } });
    return Response.json({ head: 42, revision: 42, repeated: false, merged: [], rewritten: [], wanted: [] });
  }) as typeof fetch;
  const waits: number[] = [];
  const client = new Wiki('https://acme.example.com/', 'awt_x', { fetch: fakeFetch, sleep: async (ms) => void waits.push(ms) });
  const result = await client.commit(body, key);
  assert.equal(result.revision, 42);
  assert.deepEqual(waits, [2000], 'waits out Retry-After, then retries');
  assert.equal(sent[1].url, 'https://acme.example.com/api/changes');
  const headers = sent[1].init.headers as Record<string, string>;
  assert.equal(headers['idempotency-key'], `acme/api@${sha}`);
  assert.equal(headers.authorization, 'Bearer awt_x');
  assert.deepEqual(JSON.parse(String(sent[1].init.body)), body);
});

test('wiki errors keep their code and details', async () => {
  const fakeFetch = (async () => Response.json({ error: { code: 'broken_links', message: 'broken', details: { links: [1] } } }, { status: 422 })) as unknown as typeof fetch;
  const client = new Wiki('https://w', 't', { fetch: fakeFetch });
  await assert.rejects(client.commit({ base: 1, message: 'm', changes: [] }, 'k'), (error: unknown) => error instanceof ApiError && error.status === 422 && error.code === 'broken_links');
});
