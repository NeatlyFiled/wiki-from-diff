# wiki-from-diff

A GitHub Action that keeps your [Neatlyfiled](https://neatlyfiled.com) wiki in
step with your code. On each push it hands the push's diff to a Claude agent
(on your Anthropic API key). The agent reads your wiki, updates the pages that
document what changed (APIs, configuration, architecture, data models,
runbooks), and the action saves all of its edits as **one wiki revision per
push**, linked to the commit.

- Edits are staged while the agent works and sent together at the end, so a
  failed or cancelled run leaves the wiki untouched.
- The agent prefers section edits, keeps each page's style, creates pages only
  for genuinely new concepts, and makes no edits when nothing needs updating.
- Re-running a job never writes twice: the revision is keyed to the commit.

## Setup

1. In the wiki, create a **write** token: **Admin → Agent tokens**. Save it as
   the repository secret `NEATLYFILED_WIKI_TOKEN`.
2. Save your Anthropic API key as the secret `ANTHROPIC_API_KEY`.
3. Add the workflow:

```yaml
# .github/workflows/wiki.yml
name: Wiki docs

on:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: wiki-docs
  cancel-in-progress: false

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the action diffs the push, so it needs the history
      - uses: ChristianBako/agent-wiki/actions/wiki-from-diff@main
        with:
          wiki-url: https://acme.neatlyfiled.com
          wiki-token: ${{ secrets.NEATLYFILED_WIKI_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          folder: engineering/api # optional
```

The job needs only `contents: read`: the action reads the checkout and talks
to the wiki and the Anthropic API with the tokens you give it. The
`concurrency` group runs one docs job at a time, so pushes are documented in
order and do not edit the same pages at once.

## Inputs

| Input | Default | Does |
| --- | --- | --- |
| `wiki-url` | required | The wiki, e.g. `https://acme.neatlyfiled.com` |
| `wiki-token` | required | A write token (`awt_…`) |
| `anthropic-api-key` | required | Your Anthropic API key |
| `model` | see `DEFAULT_MODEL` in `src/agent.ts` | The Claude model the agent uses |
| `folder` | | Where this repository's pages live; the agent looks there first and puts new pages there |
| `instructions` | | Extra guidance for the agent, e.g. "keep docs/runbooks/ current; never edit the changelog" |
| `ignore` | | Globs (one per line or comma-separated) to leave out of the diff, on top of the built-in ones: lockfiles, `dist/`, `build/`, `out/`, `coverage/`, `vendor/`, `node_modules/`, minified, source maps, snapshots, generated code and binary files |
| `max-diff-bytes` | `120000` | Most bytes of diff the agent sees; bigger diffs are cut per file (small files stay whole) with a note of what was cut |
| `dry-run` | `false` | `true` runs the agent and prints the planned revision without saving it |

Globs work like `.gitignore`: `docs/` matches a folder anywhere, `*.svg` a file
name anywhere, `api/legacy/**` a path from the repository root.

## Outputs

| Output | Is |
| --- | --- |
| `revision` | The wiki revision saved for this push (empty if none) |
| `pages` | The pages changed, one path per line |
| `skipped` | Why no revision was saved, if none was: `dry-run`, no documentable changes, a `[skip wiki]` commit, or nothing to update |

Each run also writes a job summary with links to the changed pages and the
revision, or why it skipped.

## What gets documented

- **A push** to an existing branch: the commits between the old and the new
  head.
- **A new branch**: its commits since it left the default branch.
- **A force push**: the new commits since the old and new histories split.
- **`workflow_dispatch`**: the last commit.

The agent sees the commit messages, the list of changed files and the diff.
It does not see the rest of your code, so it documents only what the diff
shows.

## Skipping a push

Put `[skip wiki]` in any commit message of the push. The action then stops
before calling the model. (`[skip ci]` skips the whole workflow, as usual.)

## Cost

Every documented push is a conversation with Claude on your Anthropic API key:
the diff (up to `max-diff-bytes`, about 30k tokens at the default), the pages
the agent reads, and the pages it writes, over up to 30 model turns. The
action caches the prompt between turns to keep repeated input cheap. Pushes
skipped by `[skip wiki]` or with only ignored files cost nothing; lower
`max-diff-bytes` or choose a smaller `model` to spend less. A re-run of a
documented push asks the model again but saves nothing new.

## Errors

- **Missing commits**: check out with `fetch-depth: 0`.
- **Broken links** in the agent's pages: the agent gets the wiki's list once to
  fix them, then the action retries.
- **Conflict**: someone edited the same lines while the agent worked; re-run
  the job.
- **Rate limits** (wiki or Anthropic): the action waits and retries.
- **Wiki locked or full** (402, 413): the job fails with the wiki's message.
