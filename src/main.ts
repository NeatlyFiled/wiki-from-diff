// wiki-from-diff: on a push, a Claude agent reads the pushed diff and the
// wiki, updates the pages that document what changed, and the action saves
// all of its edits as one wiki revision. GitHub runs this file with Node 24,
// which strips the types; inputs arrive as INPUT_* variables.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { appendText, converse, DEFAULT_MODEL, MAX_TURNS, systemPrompt, type AgentOptions, type Message } from './agent.ts';
import { BUILTIN_IGNORES, collect, describe, pickRange, repoHistory, splitList, type PushEvent } from './diff.ts';
import { ApiError, commitRequest, Staging, Wiki, type CommitResult } from './wiki.ts';

/** Turns the agent gets to fix links the wiki rejected. */
const FIX_TURNS = 10;
const MAX_LISTED_PAGES = 300;
const SKIP_MARKER = '[skip wiki]';

const env = process.env;
const input = (name: string) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

function required(name: string): string {
  const value = input(name);
  if (!value) throw new Error(`the "${name}" input is required`);
  return value;
}

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

function skip(reason: string, heading: string): void {
  console.log(`Skipped: ${reason}`);
  setOutput('skipped', reason);
  setOutput('pages', '');
  setOutput('revision', '');
  summarize(`### ${heading}\n\nWiki not updated: ${reason}.`);
}

async function main(): Promise<void> {
  const wikiUrl = required('wiki-url').replace(/\/+$/, '');
  const token = required('wiki-token');
  const apiKey = required('anthropic-api-key');
  console.log(`::add-mask::${token}`);
  console.log(`::add-mask::${apiKey}`);
  const maxBytes = Number(input('max-diff-bytes') || 120_000);
  if (!Number.isInteger(maxBytes) || maxBytes < 1000) throw new Error('"max-diff-bytes" must be a whole number of at least 1000');
  const dryRun = input('dry-run') === 'true';
  const folder = input('folder') || undefined;

  const repo = env.GITHUB_REPOSITORY ?? 'unknown/repository';
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
  const sha = change.range.head;
  const heading = `Wiki docs for ${repo}@${sha.slice(0, 7)}`;
  if (change.commits.some((commit) => commit.message.toLowerCase().includes(SKIP_MARKER))) return skip(`a commit message contains ${SKIP_MARKER}`, heading);
  if (!change.files.length) return skip('no documentable changes in the diff', heading);
  const { text: diff, cut } = describe(change, maxBytes);
  if (cut.length) console.log(`::notice::diff cut to fit max-diff-bytes (${maxBytes}): ${cut.join('; ')}`);

  const wiki = new Wiki(wikiUrl, token);
  const { head: base, pages } = await wiki.listPages();
  const staging = new Staging(wiki);
  const listed = pages.slice(0, MAX_LISTED_PAGES).map((page) => `- ${page.path} — ${page.title}`);
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `The wiki has ${pages.length} page(s)${pages.length > MAX_LISTED_PAGES ? ` (first ${MAX_LISTED_PAGES} listed; use list_pages for the rest)` : ''}:`,
            ...listed,
            '',
            `# Push to ${repo}`,
            '',
            diff,
          ].join('\n'),
        },
      ],
    },
  ];
  const agent: AgentOptions = {
    apiKey,
    model: input('model') || DEFAULT_MODEL,
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    system: systemPrompt({ repo, folder, instructions: input('instructions') }),
    wiki,
    staging,
  };
  let summary = await group(`Agent (${agent.model})`, () => converse(messages, MAX_TURNS, agent));
  console.log(summary);

  if (!staging.changes.length) return skip('the agent found nothing to update', heading);
  const request = () => commitRequest({ repo, sha, serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com', base, summary, changes: staging.changes });

  if (dryRun) {
    const { body, key } = request();
    await group('Planned revision (dry run)', () => console.log(JSON.stringify({ ...body, idempotencyKey: key }, null, 2)));
    const { pages: planned } = staging.summary();
    setOutput('pages', planned.join('\n'));
    setOutput('skipped', 'dry-run');
    setOutput('revision', '');
    summarize(`### ${heading}\n\nDry run: would change ${planned.map((file) => `\`${file}\``).join(', ')}.\n\n${summary}`);
    return;
  }

  let result: CommitResult | undefined;
  for (let fixed = false; !result; fixed = true) {
    const { body, key } = request();
    try {
      result = await wiki.commit(body, key);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'broken_links' && !fixed) {
        console.log(`::warning::the wiki rejected broken links; asking the agent to fix them: ${JSON.stringify(error.details)}`);
        appendText(messages, `Saving your edits failed: ${error.message}\n${JSON.stringify(error.details, null, 2)}\nFix these links in your staged pages, then reply with your full summary again.`);
        summary = (await group('Agent: fixing links', () => converse(messages, FIX_TURNS, agent))) || summary;
        continue;
      }
      if (error.status === 409) {
        throw new Error(`the wiki changed under this run (${error.code}: ${error.message}); re-run the job to document the push against the latest pages`);
      }
      throw new Error(`the wiki refused the revision (${error.status} ${error.code}): ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ''}`);
    }
  }

  const { pages: final, moves } = staging.summary();
  setOutput('pages', final.join('\n'));
  setOutput('revision', String(result.revision));
  setOutput('skipped', '');
  console.log(result.repeated ? `Already saved as revision ${result.revision} by an earlier run` : `Saved revision ${result.revision}`);
  const urls = new Map((await wiki.listPages()).pages.map((page) => [page.path, page.url]));
  const link = (file: string) => (urls.has(file) ? `[\`${file}\`](${wikiUrl}${urls.get(file)})` : `\`${file}\``);
  summarize(
    [
      `### ${heading}`,
      '',
      `[Revision ${result.revision}](${wikiUrl}/-/revisions/${result.revision})${result.repeated ? ' (saved by an earlier run of this push)' : ''}:`,
      '',
      ...final.map((file) => `- ${link(file)}`),
      ...moves.map(([from, to]) => `- moved \`${from}\` → \`${to}\``),
      '',
      summary,
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::wiki-from-diff: ${message}`);
  summarize(`### Wiki docs failed\n\n${message}`);
  process.exitCode = 1;
}
