# wiki-from-diff

A GitHub Action that keeps your [Neatlyfiled](https://neatlyfiled.com) wiki in
step with your code. On each push it sends the push's diff to your wiki, whose
agent reads the wiki, updates the pages that document what changed (APIs,
configuration, architecture, data models, runbooks) and saves all of its edits
as **one wiki revision per push**, linked to the commit.

- **No secrets.** The job proves which repository it runs in with GitHub's
  OIDC token; your wiki accepts pushes only from repositories an admin has
  connected. There is no wiki token or model key to store.
- The agent prefers section edits, keeps each page's style, creates pages only
  for genuinely new concepts, and makes no edits when nothing needs updating.
- Edits are saved together at the end, so a failed run leaves the wiki
  untouched, and re-running a job never writes twice: the revision is keyed to
  the commit, and a documented push is not sent to the model again.

## Setup

1. In the wiki, open **Admin → Connected repositories** and add your
   repository (`owner/repo`). The page shows this workflow with your wiki
   filled in.
2. Add the workflow:

```yaml
# .github/workflows/wiki.yml
name: Wiki docs
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write # lets the job prove to the wiki which repository it is
jobs:
  wiki:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the action diffs the push, so it needs the history
      - uses: neatlyfiled/wiki-from-diff@v1
        with:
          wiki: acme # your subdomain, or the wiki's full https address
```

## Inputs

| Input | Default | Does |
| --- | --- | --- |
| `wiki` | required | Your wiki: its subdomain (`acme` for `https://acme.neatlyfiled.com`) or its address |
| `folder` | | Where this repository's pages live; the agent looks there first and puts new pages there |
| `instructions` | | Extra guidance for the agent, e.g. "keep docs/runbooks/ current; never edit the changelog" |
| `ignore` | | Globs (one per line or comma-separated) to leave out of the diff, on top of the built-in ones: lockfiles, `dist/`, `build/`, `out/`, `coverage/`, `vendor/`, `node_modules/`, minified, source maps, snapshots, generated code and binary files |
| `max-diff-bytes` | `120000` | Most bytes of diff sent; bigger diffs are cut per file (small files stay whole) with a note of what was cut |
| `dry-run` | `false` | `true` runs the agent and prints the planned revision without saving it |

Globs work like `.gitignore`: `docs/` matches a folder anywhere, `*.svg` a file
name anywhere, `api/legacy/**` a path from the repository root.

## Outputs

| Output | Is |
| --- | --- |
| `revision` | The wiki revision saved for this push (empty if none) |
| `pages` | The pages changed, one path per line |
| `skipped` | Why no revision was saved, if none was: `dry-run`, no documentable changes, a `[skip wiki]` commit, or nothing to update |

Each run also prints the agent's summary and writes a job summary with the
changed pages and a link to the revision, or why it skipped.

## What gets documented

- **A push** to an existing branch: the commits between the old and the new
  head.
- **A new branch**: its commits since it left the default branch.
- **A force push**: the new commits since the old and new histories split.
- **`workflow_dispatch`**: the last commit.

The wiki gets the commit messages, the list of changed files and the diff, not
the rest of your code, so the agent documents only what the diff shows.

## Skipping a push

Put `[skip wiki]` in any commit message of the push. The action then stops
before sending anything. (`[skip ci]` skips the whole workflow, as usual.)

## Usage and limits

The agent's model usage is included in your Neatlyfiled plan. Each wiki takes
a limited number of CI runs a day (50 by default); pushes skipped with
`[skip wiki]`, pushes that change only ignored files and re-runs of a
documented push do not count. A locked wiki (trial or subscription ended)
refuses runs until it is renewed. Recent runs, with their outcome and token
usage, are listed under Admin → Connected repositories.

## Errors

- **`id-token: write` missing**: GitHub gives the job no OIDC token; add the
  permission.
- **Missing commits**: check out with `fetch-depth: 0`.
- **`repository_not_connected` (403)**: connect the repository in the wiki's
  admin page (the name must match `owner/repo`).
- **Broken links** in the agent's pages: the agent gets the wiki's list once to
  fix them before saving.
- **Conflict**: someone edited the same lines while the agent worked; re-run
  the job.
- **`rate_limited` (429)**: the wiki's daily CI runs are used up.
- **`locked` (402)**: the wiki's trial or subscription has ended.
- The action waits up to 10 minutes for a run; a longer run still finishes in
  the wiki.

## Releasing

The action's source lives in the `agent-wiki` monorepo under
`actions/wiki-from-diff/`; customers use the public copy at
[`NeatlyFiled/wiki-from-diff`](https://github.com/NeatlyFiled/wiki-from-diff).
To publish a change, from the monorepo root:

```sh
git subtree split --prefix actions/wiki-from-diff -b wiki-from-diff-release
git push git@github.com:NeatlyFiled/wiki-from-diff.git wiki-from-diff-release:main
git push -f git@github.com:NeatlyFiled/wiki-from-diff.git wiki-from-diff-release:refs/tags/v1   # move v1; also tag v1.x.y
git branch -D wiki-from-diff-release
```
