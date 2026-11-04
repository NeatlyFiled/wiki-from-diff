// What a push changed, as text for the agent: which commits to compare, the
// commit messages, the files touched and their diffs, minus noise (lockfiles,
// build output, binaries) and cut to fit a byte budget.
import { execFileSync } from 'node:child_process';

/** Git's empty tree: the base when the pushed history starts at a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Files that change with code but say nothing a wiki should repeat. */
export const BUILTIN_IGNORES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'flake.lock', 'mix.lock',
  'dist/', 'build/', 'out/', 'coverage/', 'node_modules/', 'vendor/', 'third_party/', '__generated__/', 'generated/',
  '*.min.js', '*.min.css', '*.map', '*.snap', '*.generated.*', '*.pb.go', '*_pb2.py', '*_pb2.pyi',
];

/** Files whose diff is cut shorter than this are left out, with a note. */
const MIN_FILE_BYTES = 400;
const MAX_COMMITS = 50;
const MAX_MESSAGE_CHARS = 2000;

export type Range = { base: string; head: string; note?: string };

/** The few questions about history that choosing a range needs. */
export type History = {
  has(sha: string): boolean;
  parent(sha: string): string | undefined;
  mergeBase(a: string, b: string): string | undefined;
  shallow(): boolean;
};

export type PushEvent = {
  before?: string;
  after?: string;
  ref?: string;
  forced?: boolean;
  repository?: { default_branch?: string };
};

const missing = (sha: string) =>
  new Error(`commit ${sha} is not in the checkout: use actions/checkout with "fetch-depth: 0" so the action can diff the push`);

/**
 * The commits a run documents. A push compares `before` with `after`; a new
 * branch compares with where it left the default branch (or its parent); a
 * force push with where the old and new histories split; anything else
 * (workflow_dispatch) documents the last commit.
 */
export function pickRange(eventName: string, event: PushEvent, sha: string, git: History): Range {
  const lastCommit = (head: string, note?: string): Range => {
    const parent = git.parent(head);
    if (parent) return { base: parent, head, note };
    if (git.shallow()) throw missing(`${head}^`);
    return { base: EMPTY_TREE, head, note };
  };
  if (eventName !== 'push' || !event.after) {
    if (!git.has(sha)) throw missing(sha);
    return lastCommit(sha);
  }
  const head = event.after;
  if (!git.has(head)) throw missing(head);
  const before = event.before;
  if (!before || /^0+$/.test(before)) {
    const main = event.repository?.default_branch;
    if (main && event.ref !== `refs/heads/${main}`) {
      const split = git.mergeBase(`origin/${main}`, head);
      if (split && split !== head) return { base: split, head, note: `new branch: changes since it left ${main}` };
    }
    return lastCommit(head, 'new branch: documenting its last commit');
  }
  if (!git.has(before)) {
    if (event.forced) return lastCommit(head, 'force push and the old head is not in the checkout: documenting the last commit');
    throw missing(before);
  }
  if (event.forced) {
    const split = git.mergeBase(before, head);
    if (split) return { base: split, head, note: 'force push: changes since the old and new histories split' };
  }
  return { base: before, head };
}

/** Matches a path against gitignore-style globs: `dir/` is a folder anywhere, a pattern without `/` matches a file name at any depth. */
export function ignored(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globRegExp(pattern).test(file));
}

function globRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/^\.?\//, '');
  const folder = glob.endsWith('/');
  if (folder) glob = glob.slice(0, -1);
  const anchored = glob.includes('/');
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${source}${folder ? '/' : '$'}`);
}

/** `"a, b\nc"` -> `['a', 'b', 'c']`. */
export const splitList = (input: string) =>
  input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export type FileDiff = { path: string; added: number; deleted: number; diff: string };

/**
 * Fits the diffs into `budget` bytes: small diffs stay whole and the rest
 * share what is left equally, each cut at a line end. Returns the text and
 * what was cut.
 */
export function fitDiffs(files: FileDiff[], budget: number): { text: string; cut: string[] } {
  const size = (text: string) => Buffer.byteLength(text);
  const caps = new Map<FileDiff, number>();
  let remaining = budget;
  let left = files.length;
  for (const file of [...files].sort((a, b) => size(a.diff) - size(b.diff))) {
    const share = Math.floor(remaining / left--);
    const cap = Math.min(size(file.diff), share);
    caps.set(file, cap);
    remaining -= cap;
  }
  const cut: string[] = [];
  const parts = files.map((file) => {
    const total = size(file.diff);
    const cap = caps.get(file)!;
    if (cap >= total) return file.diff.endsWith('\n') ? file.diff : `${file.diff}\n`;
    if (cap < MIN_FILE_BYTES) {
      cut.push(`${file.path} (left out)`);
      return `[diff of ${file.path} left out: ${total} bytes]\n`;
    }
    const kept = Buffer.from(file.diff).subarray(0, cap).toString();
    const end = kept.lastIndexOf('\n') + 1;
    cut.push(`${file.path} (kept ${end} of ${total} bytes)`);
    return `${kept.slice(0, end)}[… ${file.path} truncated: kept ${end} of ${total} bytes]\n`;
  });
  return { text: parts.join(''), cut };
}

export type Commit = { sha: string; author: string; message: string };

export type Change = {
  range: Range;
  commits: Commit[];
  files: FileDiff[];
  /** Paths left out, with why. */
  skipped: { path: string; reason: string }[];
};

/** Runs git in `cwd` and returns stdout. */
export const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

/** `History` backed by the repository at `cwd`. */
export function repoHistory(cwd: string): History {
  const attempt = (args: string[]) => {
    try {
      return git(cwd, args).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  return {
    has: (sha) => attempt(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== undefined,
    parent: (sha) => attempt(['rev-parse', '--verify', '--quiet', `${sha}^1`]),
    mergeBase: (a, b) => attempt(['merge-base', a, b]),
    shallow: () => attempt(['rev-parse', '--is-shallow-repository']) === 'true',
  };
}

/** The commits and per-file diffs between `range.base` and `range.head`, without ignored and binary files. */
export function collect(cwd: string, range: Range, ignore: string[]): Change {
  const log = git(cwd, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%an%x1f%B%x1e', range.base === EMPTY_TREE ? range.head : `${range.base}..${range.head}`]);
  const commits = log
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, author, message] = record.split('\x1f');
      return { sha, author, message: message.trim().slice(0, MAX_MESSAGE_CHARS) };
    });
  const files: FileDiff[] = [];
  const skipped: Change['skipped'] = [];
  // -z: one "added\tdeleted\tpath" record per NUL, paths unquoted.
  const stats = git(cwd, ['diff', '--numstat', '-z', '--no-renames', range.base, range.head]).split('\0').filter(Boolean);
  for (const record of stats) {
    const [added, deleted, ...rest] = record.split('\t');
    const path = rest.join('\t');
    if (added === '-') skipped.push({ path, reason: 'binary' });
    else if (ignored(path, ignore)) skipped.push({ path, reason: 'ignored' });
    else {
      const diff = git(cwd, ['diff', '--no-renames', '--no-color', range.base, range.head, '--', `:(literal)${path}`]);
      if (diff) files.push({ path, added: Number(added), deleted: Number(deleted), diff });
    }
  }
  return { range, commits, files, skipped };
}

/** Most files listed to the wiki, diffed and left out alike. */
const MAX_LISTED_FILES = 2000;

/** The push as the wiki's CI endpoint takes it, with the diffs fitted into `maxBytes`. */
export function runPayload(change: Change, maxBytes: number) {
  const { text, cut } = fitDiffs(change.files, maxBytes);
  const note = cut.length ? `\n[Diff cut to fit ${maxBytes} bytes: ${cut.join('; ')}. Document only what the diff shows.]\n` : '';
  const files = [
    ...change.files.map(({ path, added, deleted }) => ({ path, added, deleted })),
    ...change.skipped.map(({ path, reason }) => ({ path, skipped: reason })),
  ].slice(0, MAX_LISTED_FILES);
  return {
    sha: change.range.head,
    note: [change.range.base === EMPTY_TREE ? 'from the first commit' : `since ${change.range.base.slice(0, 7)}`, change.range.note].filter(Boolean).join('; '),
    commits: change.commits.map((commit) => ({ ...commit, author: commit.author.slice(0, 200) })),
    files,
    diff: `${text}${note}`,
    cut,
  };
}
