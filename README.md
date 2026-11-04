# wiki-from-diff

A GitHub Action that connects a repository to your
[Neatlyfiled](https://neatlyfiled.com) wiki, the shared context your agents and
your people work from. It does two things on each push, with no secrets and no
model on our side:

1. **Records the push** as a wiki page: the commits, a table of the files
   changed and the diff per file, with links to the commit (or comparison) on
   GitHub. Pages live under `changes/<repository>/<year>/<month>/`, and
   `changes/<repository>/` lists the latest 50, newest first. Any agent or
   person can read what changed without access to the code.
2. **Lets your agent in.** It hands the job a short-lived write token for the
   wiki (an hour), with its MCP and API addresses, so the next step can run
   **your own agent with your own model and key** to update the docs: in
   Neatlyfiled, CI is just another flow for agents.

- **No secrets.** The job proves which repository it runs in with GitHub's
  OIDC token; your wiki accepts only repositories an admin has connected.
  There is no wiki token to store.
- **Re-runs never write twice**: a push's page is keyed to the commit.
- The token works only on your wiki, only while the repository stays
  connected, and only for an hour. Its changes show in the wiki's history as
  `ci:<owner/repo>`.

## Setup

1. In the wiki, open **Admin → Connected repositories** and add your
   repository (`owner/repo`). The page shows this workflow with your wiki
   filled in.
2. Add the workflow:

```yaml
# .github/workflows/neatlyfiled-wiki.yml
name: Wiki
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
        id: wiki
        with:
          wiki: acme # your subdomain, or the wiki's full https address
```

That records every push. To have your agent update the docs too, add a step.

## Let your agent update the docs

The step's outputs are all your agent needs: `token`, `mcp-url` and
`api-url`, plus `page`, the path of the push's page (its context).

### Claude Code

With [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
and your `ANTHROPIC_API_KEY` in the repository's secrets, after the step above:

```yaml
      - uses: anthropics/claude-code-action@v1
        if: steps.wiki.outputs.skipped == ''
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}
          prompt: |
            Commit ${{ github.sha }} was pushed to ${{ github.repository }}. The wiki
            (MCP server "wiki") has a page about it at ${{ steps.wiki.outputs.page }}
            with the commits and the diff; the code is checked out here.
            Read that page, search the wiki for the pages that document what
            changed (APIs, configuration, architecture, runbooks), and update
            them. Prefer edit_section; send the revision you read as base when
            you replace a page. If nothing needs updating, change nothing.
          claude_args: |
            --mcp-config '{"mcpServers":{"wiki":{"type":"http","url":"${{ steps.wiki.outputs.mcp-url }}","headers":{"Authorization":"Bearer ${{ steps.wiki.outputs.token }}"}}}}'
            --allowedTools mcp__wiki
```

`mcp__wiki` allows every tool of the wiki's MCP server (`search`,
`read_page`, `edit_section`, `write_page`, …); list single tools instead to
narrow it, e.g. `mcp__wiki__search,mcp__wiki__read_page,mcp__wiki__edit_section`.

### Any agent, or a script

Any MCP client takes the wiki at `steps.wiki.outputs.mcp-url` (streamable
HTTP) with the header `Authorization: Bearer <token>`. Without MCP, the JSON
API at `steps.wiki.outputs.api-url` takes the same header:

```yaml
      - name: Read the push's page and append to the changelog
        env:
          WIKI_API: ${{ steps.wiki.outputs.api-url }}
          WIKI_TOKEN: ${{ steps.wiki.outputs.token }}
          PAGE: ${{ steps.wiki.outputs.page }}
        run: |
          curl -fsS -H "Authorization: Bearer $WIKI_TOKEN" "$WIKI_API/pages/$PAGE" | jq -r .content
          curl -fsS -X PATCH -H "Authorization: Bearer $WIKI_TOKEN" -H 'content-type: application/json' \
            -d "{\"section\": \"Changes\", \"mode\": \"append\", \"content\": \"- ${GITHUB_SHA::7}: see [the push](/$PAGE)\", \"message\": \"Changelog for ${GITHUB_SHA::7}\"}" \
            "$WIKI_API/pages/engineering/changelog.md"
```

The API's routes and MCP tools are listed in the wiki's docs
(`/llms.txt` on your wiki lists its pages).

## Inputs

| Input | Default | Does |
| --- | --- | --- |
| `wiki` | required | Your wiki: its subdomain (`acme` for `https://acme.neatlyfiled.com`) or its address |
| `record` | `true` | `false` skips recording the push; the step only gets the token |
| `folder` | `changes/<repository name>` | Wiki folder for this repository's push pages |
| `ignore` | | Globs (one per line or comma-separated) to leave out of the diff, on top of the built-in ones: lockfiles, `dist/`, `build/`, `out/`, `coverage/`, `vendor/`, `node_modules/`, minified, source maps, snapshots, generated code and binary files. Left-out files are still listed |
| `max-diff-bytes` | `120000` | Most bytes of diff sent; bigger diffs are cut per file (small files stay whole), and the page says so |

Globs work like `.gitignore`: `docs/` matches a folder anywhere, `*.svg` a file
name anywhere, `api/legacy/**` a path from the repository root.

## Outputs

| Output | Is |
| --- | --- |
| `token` | A write token for the wiki, valid for an hour (masked in logs) |
| `mcp-url` | The wiki's MCP server, e.g. `https://acme.neatlyfiled.com/mcp` |
| `api-url` | The wiki's JSON API, e.g. `https://acme.neatlyfiled.com/api` |
| `wiki-url` | The wiki's address |
| `page` | The push's page, e.g. `changes/api/2026/11/2026-11-04-abc1234.md` (when recorded) |
| `revision` | The wiki revision that recorded it (when recorded) |
| `skipped` | Why the push was not recorded, if a commit message has `[skip wiki]` |

## What gets recorded

- **A push** to an existing branch: the commits between the old and the new
  head.
- **A new branch**: its commits since it left the default branch.
- **A force push**: the new commits since the old and new histories split.
- **`workflow_dispatch`**: the last commit.

The wiki gets the commit messages, the list of changed files and the diff, not
the rest of your code. Put `[skip wiki]` in any commit message to leave a push
out (the token is still issued). `[skip ci]` skips the whole workflow, as
usual.

## Limits

Each wiki records up to 120 pushes and issues up to 120 CI tokens an hour;
re-runs of a recorded push do not count. A token's API and MCP calls count
toward the wiki's usual API limits. A locked wiki (trial or subscription
ended) refuses new pushes until it is renewed. Recent pushes and tokens are
listed under Admin → Connected repositories.

## Errors

- **`id-token: write` missing**: GitHub gives the job no OIDC token; add the
  permission.
- **Missing commits**: check out with `fetch-depth: 0`.
- **`repository_not_connected` (403)**: connect the repository in the wiki's
  admin page (the name must match `owner/repo`).
- **`invalid_token` (401) in your agent's step**: the token expired (an hour),
  or the repository was disconnected; re-run the job.
- **`rate_limited` (429)**: the wiki's hourly pushes or tokens are used up.
- **`locked` (402)**: the wiki's trial or subscription has ended.

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
