import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUILTIN_IGNORES, collect, EMPTY_TREE, fitDiffs, ignored, pickRange, pushPayload, type History } from '../src/diff.ts';

const ZERO = '0'.repeat(40);

/** History over a made-up commit graph: sha -> parent. */
function history(parents: Record<string, string | undefined>, options: { mergeBases?: Record<string, string>; shallow?: boolean } = {}): History {
  return {
    has: (sha) => sha in parents,
    parent: (sha) => parents[sha],
    mergeBase: (a, b) => options.mergeBases?.[`${a} ${b}`],
    shallow: () => options.shallow ?? false,
  };
}

test('a push compares before with after', () => {
  const git = history({ a: undefined, b: 'a', c: 'b' });
  assert.deepEqual(pickRange('push', { before: 'a', after: 'c' }, 'c', git), { base: 'a', head: 'c' });
});

test('a new branch compares with where it left the default branch, else with its parent', () => {
  const git = history({ m: undefined, f1: 'm', f2: 'f1' }, { mergeBases: { 'origin/main f2': 'm' } });
  const event = { before: ZERO, after: 'f2', ref: 'refs/heads/feature', repository: { default_branch: 'main' } };
  assert.equal(pickRange('push', event, 'f2', git).base, 'm');
  assert.equal(pickRange('push', { ...event, ref: 'refs/heads/main' }, 'f2', git).base, 'f1');
  assert.equal(pickRange('push', { before: ZERO, after: 'm' }, 'm', git).base, EMPTY_TREE);
});

test('a force push compares with where the histories split, or the last commit when the old head is gone', () => {
  const git = history({ m: undefined, old: 'm', new: 'm' }, { mergeBases: { 'old new': 'm' } });
  assert.equal(pickRange('push', { before: 'old', after: 'new', forced: true }, 'new', git).base, 'm');
  const range = pickRange('push', { before: 'gone', after: 'new', forced: true }, 'new', git);
  assert.equal(range.base, 'm');
  assert.match(range.note!, /force push/);
});

test('missing commits fail with a hint about fetch-depth', () => {
  const git = history({ b: 'a' });
  assert.throws(() => pickRange('push', { before: 'a', after: 'b' }, 'b', git), /fetch-depth: 0/);
  assert.throws(() => pickRange('push', { before: 'b', after: 'c' }, 'c', git), /fetch-depth: 0/);
  // A shallow clone hides the parent: that is not a root commit.
  assert.throws(() => pickRange('workflow_dispatch', {}, 'x', history({ x: undefined }, { shallow: true })), /fetch-depth: 0/);
});

test('other events cover the last commit', () => {
  assert.deepEqual(pickRange('workflow_dispatch', {}, 'b', history({ a: undefined, b: 'a' })), { base: 'a', head: 'b', note: undefined });
});

test('ignore globs: names anywhere, folders anywhere, anchored paths', () => {
  const patterns = [...BUILTIN_IGNORES, 'docs/legacy/**', '*.svg'];
  for (const file of ['package-lock.json', 'web/yarn.lock', 'dist/app.js', 'apps/web/dist/x.js', 'lib/app.min.js', 'src/api.generated.ts', 'docs/legacy/a/b.md', 'icons/logo.svg']) {
    assert.ok(ignored(file, patterns), file);
  }
  for (const file of ['src/build.ts', 'distance.ts', 'docs/legacy.md', 'README.md', 'src/lock.ts']) assert.ok(!ignored(file, patterns), file);
});

test('fitDiffs keeps small diffs whole and cuts big ones at a line end', () => {
  const line = (n: number) => `+line ${String(n).padStart(4, '0')}\n`;
  const big = Array.from({ length: 500 }, (_, i) => line(i)).join('');
  const files = [
    { path: 'small.ts', status: 'modified', added: 1, deleted: 0, diff: '+tiny\n' },
    { path: 'big.ts', status: 'added', added: 500, deleted: 0, diff: big },
    { path: 'huge.ts', status: 'added', added: 500, deleted: 0, diff: big + big },
  ];
  const { text, cut } = fitDiffs(files, 4000);
  assert.ok(Buffer.byteLength(text) <= 4000, `${Buffer.byteLength(text)} bytes`);
  assert.ok(text.startsWith('+tiny\n'));
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(cut.map((entry) => [entry.path, entry.how]), [['big.ts', 'truncated'], ['huge.ts', 'truncated']]);
  assert.match(cut[0].note, /^big\.ts \(kept \d+ of 5500 bytes\)$/);
  // Too little room for a useful piece: the file is left out.
  const tight = fitDiffs(files, 600);
  assert.deepEqual(tight.cut.map((entry) => entry.how), ['omitted', 'omitted']);
  assert.equal(tight.text, '+tiny\n');
});

test('collect a real repository and build the push payload: statuses, dates, ignored and binary files listed, not diffed', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wfd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(path.join(dir, 'api.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'old.ts'), 'gone\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'api.ts'), 'export const a = 2;\n');
  writeFileSync(path.join(dir, 'new.ts'), 'export const b = 1;\n');
  writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0, 1, 2, 0, 255]));
  git('rm', '-q', 'old.ts');
  git('add', '.');
  git('commit', '-qm', 'Bump a\n\nBecause.');
  const head = git('rev-parse', 'HEAD');
  const change = collect(dir, { base, head }, BUILTIN_IGNORES);
  assert.deepEqual(change.commits.map((commit) => commit.message), ['Bump a\n\nBecause.']);
  assert.match(change.commits[0].date, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(change.files.map((file) => [file.path, file.status, file.added, file.deleted]), [['api.ts', 'modified', 1, 1], ['new.ts', 'added', 1, 0], ['old.ts', 'deleted', 0, 1]]);
  assert.deepEqual(change.skipped, [{ path: 'logo.png', status: 'added', reason: 'binary' }, { path: 'package-lock.json', status: 'added', reason: 'ignored' }]);
  const payload = pushPayload(change, 120_000);
  assert.equal(payload.sha, head);
  assert.equal(payload.before, base);
  assert.equal(payload.note, `since ${base.slice(0, 7)}`);
  assert.deepEqual(payload.files, [
    { path: 'api.ts', status: 'modified', added: 1, deleted: 1, cut: undefined },
    { path: 'new.ts', status: 'added', added: 1, deleted: 0, cut: undefined },
    { path: 'old.ts', status: 'deleted', added: 0, deleted: 1, cut: undefined },
    { path: 'logo.png', status: 'added', skipped: 'binary' },
    { path: 'package-lock.json', status: 'added', skipped: 'ignored' },
  ]);
  assert.match(payload.diff, /^diff --git a\/api\.ts b\/api\.ts\n[^]*\+export const a = 2;/);
  assert.equal(payload.diff.match(/^diff --git /gm)?.length, 3);
  assert.doesNotMatch(payload.diff, /\{\}/);
  assert.equal(payload.truncated, false);
  assert.deepEqual(payload.cut, []);
  assert.equal(pushPayload({ ...change, range: { base: EMPTY_TREE, head } }, 120_000).before, undefined);
});
