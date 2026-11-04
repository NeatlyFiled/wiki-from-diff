// wiki-from-diff: on a push, records the push in the Neatlyfiled wiki (a page
// with its commits, files and diff) and gets a short-lived write token for the
// wiki, so a later step can run the customer's own agent on it. The workflow
// proves which repository it is with GitHub's OIDC token, so the repository
// needs no secrets, and no model runs here or in the wiki. GitHub runs this
// file with Node 24, which strips the types; inputs arrive as INPUT_* variables.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { ApiError, CiClient, oidcToken, wikiOrigin } from './client.ts';
import { BUILTIN_IGNORES, collect, pickRange, pushPayload, repoHistory, splitList, type PushEvent } from './diff.ts';

const SKIP_MARKER = '[skip wiki]';

const env = process.env;
const input = (name: string) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

function setOutput(name: string, value: string): void {
  if (!env.GITHUB_OUTPUT) return console.log(`output ${name}=${value}`);
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Appends Markdown to the job's summary page. */
function summarize(markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function group<T>(title: string, run: () => T | Promise<T>): Promise<T> {
  console.log(`::group::${title}`);
  try {
    return await run();
  } finally {
    console.log('::endgroup::');
  }
}

function flag(name: string, fallback: boolean): boolean {
  const value = input(name).toLowerCase();
  if (!value) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`"${name}" is "true" or "false", not "${input(name)}"`);
  return value === 'true';
}

/** Records the push; a line for the job summary. */
async function record(client: CiClient, maxBytes: number): Promise<string> {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const event: PushEvent = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const change = await group('Diff', () => {
    const range = pickRange(env.GITHUB_EVENT_NAME ?? '', event, env.GITHUB_SHA ?? 'HEAD', repoHistory(cwd));
    const change = collect(cwd, range, [...BUILTIN_IGNORES, ...splitList(input('ignore'))]);
    console.log(`${range.base}..${range.head}${range.note ? ` (${range.note})` : ''}`);
    console.log(`${change.commits.length} commit(s), ${change.files.length} file(s) diffed, ${change.skipped.length} left out`);
    for (const file of change.skipped) console.log(`  left out ${file.path} (${file.reason})`);
    return change;
  });
  if (change.commits.some((commit) => commit.message.toLowerCase().includes(SKIP_MARKER))) {
    const reason = `a commit message contains ${SKIP_MARKER}`;
    console.log(`Not recorded: ${reason}`);
    setOutput('skipped', reason);
    return `Push not recorded: ${reason}.`;
  }
  const { cut, ...push } = pushPayload(change, maxBytes);
  if (cut.length) console.log(`::notice::diff cut to fit max-diff-bytes (${maxBytes}): ${cut.map((entry) => entry.note).join('; ')}`);
  const recorded = await client.record({
    ...push,
    repository,
    ref: env.GITHUB_REF ?? event.ref,
    serverUrl: env.GITHUB_SERVER_URL,
    folder: input('folder') || undefined,
  });
  console.log(`${recorded.repeated ? 'Already recorded' : 'Recorded'} as ${recorded.page} (revision ${recorded.revision}): ${recorded.url}`);
  setOutput('page', recorded.page);
  setOutput('revision', String(recorded.revision));
  return `Push ${recorded.repeated ? 'already recorded' : 'recorded'}: [${recorded.page}](${recorded.url}) (revision ${recorded.revision}).`;
}

async function main(): Promise<void> {
  const wiki = input('wiki');
  if (!wiki) throw new Error('the "wiki" input is required: your wiki\'s subdomain (acme) or address');
  const origin = wikiOrigin(wiki);
  const maxBytes = Number(input('max-diff-bytes') || 120_000);
  if (!Number.isInteger(maxBytes) || maxBytes < 1000) throw new Error('"max-diff-bytes" must be a whole number of at least 1000');
  const recording = flag('record', true);

  const client = new CiClient({
    origin,
    token: async () => {
      const token = await oidcToken(origin, env);
      console.log(`::add-mask::${token}`);
      return token;
    },
  });
  const lines = [recording ? await record(client, maxBytes) : 'Push not recorded ("record" is false).'];

  const minted = await client.ciToken();
  console.log(`::add-mask::${minted.token}`);
  setOutput('token', minted.token);
  setOutput('mcp-url', minted.mcp_url);
  setOutput('api-url', minted.api_url);
  setOutput('wiki-url', minted.wiki_url);
  console.log(`CI token for ${minted.wiki_url} issued, valid until ${minted.expires_at}: use steps.<id>.outputs.token with ${minted.mcp_url} or ${minted.api_url}`);
  lines.push(`CI token issued for later steps, valid until ${minted.expires_at}.`);
  summarize(`### Neatlyfiled wiki\n\n${lines.join('\n\n')}`);
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ApiError ? `${error.message} (${error.status} ${error.code})` : error instanceof Error ? error.message : String(error);
  console.log(`::error::wiki-from-diff: ${message}`);
  summarize(`### Neatlyfiled wiki failed\n\n${message}`);
  process.exitCode = 1;
}
