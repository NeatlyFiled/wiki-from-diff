// wiki-from-diff: on a push, sends the push's diff to the Neatlyfiled wiki,
// whose agent updates the pages that document what changed and saves them as
// one revision. The workflow proves which repository it is with GitHub's OIDC
// token, so the repository needs no secrets. GitHub runs this file with Node
// 24, which strips the types; inputs arrive as INPUT_* variables.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { ApiError, CiClient, oidcToken, wikiOrigin, type Run } from './client.ts';
import { BUILTIN_IGNORES, collect, pickRange, repoHistory, runPayload, splitList, type PushEvent } from './diff.ts';

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

function finish(outputs: { revision?: number; pages?: string[]; skipped?: string }, markdown: string): void {
  setOutput('revision', outputs.revision === undefined ? '' : String(outputs.revision));
  setOutput('pages', (outputs.pages ?? []).join('\n'));
  setOutput('skipped', outputs.skipped ?? '');
  summarize(markdown);
}

async function main(): Promise<void> {
  const wiki = input('wiki');
  if (!wiki) throw new Error('the "wiki" input is required: your wiki\'s subdomain (acme) or address');
  const origin = wikiOrigin(wiki);
  const maxBytes = Number(input('max-diff-bytes') || 120_000);
  if (!Number.isInteger(maxBytes) || maxBytes < 1000) throw new Error('"max-diff-bytes" must be a whole number of at least 1000');
  const dryRun = input('dry-run') === 'true';

  const repository = env.GITHUB_REPOSITORY ?? '';
  const event: PushEvent = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const cwd = env.GITHUB_WORKSPACE || process.cwd();

  const change = await group('Diff', () => {
    const range = pickRange(env.GITHUB_EVENT_NAME ?? '', event, env.GITHUB_SHA ?? 'HEAD', repoHistory(cwd));
    const change = collect(cwd, range, [...BUILTIN_IGNORES, ...splitList(input('ignore'))]);
    console.log(`${range.base}..${range.head}${range.note ? ` (${range.note})` : ''}`);
    console.log(`${change.commits.length} commit(s), ${change.files.length} file(s) to document, ${change.skipped.length} left out`);
    for (const file of change.skipped) console.log(`  left out ${file.path} (${file.reason})`);
    return change;
  });
  const heading = `Wiki docs for ${repository}@${change.range.head.slice(0, 7)}`;
  const skip = (reason: string) => {
    console.log(`Skipped: ${reason}`);
    finish({ skipped: reason }, `### ${heading}\n\nWiki not updated: ${reason}.`);
  };
  if (change.commits.some((commit) => commit.message.toLowerCase().includes(SKIP_MARKER))) return skip(`a commit message contains ${SKIP_MARKER}`);
  if (!change.files.length) return skip('no documentable changes in the diff');
  const { cut, ...push } = runPayload(change, maxBytes);
  if (cut.length) console.log(`::notice::diff cut to fit max-diff-bytes (${maxBytes}): ${cut.join('; ')}`);

  const client = new CiClient({
    origin,
    token: async () => {
      const token = await oidcToken(origin, env);
      console.log(`::add-mask::${token}`);
      return token;
    },
    log: (line) => console.log(line),
  });
  const started = await client.start({
    ...push,
    repository,
    ref: env.GITHUB_REF ?? event.ref,
    before: event.before,
    serverUrl: env.GITHUB_SERVER_URL,
    folder: input('folder') || undefined,
    instructions: input('instructions') || undefined,
    dryRun,
  });
  console.log(started.status === 'running' ? `Documenting on ${origin} (run ${started.id})…` : `${origin} already has run ${started.id} for this push`);
  const run: Run = await client.wait(started);
  if (run.summary) await group('Agent summary', () => console.log(run.summary));
  if (run.usage) console.log(`Model usage: ${run.usage.inputTokens} input, ${run.usage.outputTokens} output tokens`);
  const pages = run.pages ?? [];
  const list = [...pages.map((file) => `- \`${file}\``), ...(run.moves ?? []).map(([from, to]) => `- moved \`${from}\` → \`${to}\``)].join('\n');

  switch (run.status) {
    case 'failed':
      throw new Error(`the wiki could not document this push (${run.error?.code}): ${run.error?.message}`);
    case 'unchanged':
      return finish({ skipped: 'the agent found nothing to update' }, `### ${heading}\n\nWiki not updated: the agent found nothing to update.\n\n${run.summary ?? ''}`);
    case 'planned':
      await group('Planned revision (dry run)', () => console.log(JSON.stringify(run.plan, null, 2)));
      return finish({ pages, skipped: 'dry-run' }, `### ${heading}\n\nDry run: would change\n\n${list}\n\n${run.summary ?? ''}`);
    case 'saved':
      console.log(`${run.repeated ? 'Already saved' : 'Saved'} as revision ${run.revision}: ${run.revisionUrl}`);
      return finish(
        { revision: run.revision, pages },
        `### ${heading}\n\n[Revision ${run.revision}](${run.revisionUrl})${run.repeated ? ' (saved by an earlier run of this push)' : ''}:\n\n${list}\n\n${run.summary ?? ''}`,
      );
    default:
      throw new Error(`the wiki answered with an unknown run status "${run.status}"`);
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ApiError ? `${error.message} (${error.status} ${error.code})` : error instanceof Error ? error.message : String(error);
  console.log(`::error::wiki-from-diff: ${message}`);
  summarize(`### Wiki docs failed\n\n${message}`);
  process.exitCode = 1;
}
