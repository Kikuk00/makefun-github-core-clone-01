# GitHub Core Clone — a GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kikuk00/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kikuk00/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A single-process, stdlib-only implementation of a GitHub-compatible git forge,
built for the [make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01).

## What it serves

Everything runs from one Node process (`node /bot/main.ts`) with no install step,
no git binary, no outside service, and no UI. All state lives in memory in the
server's own store.

- **Git smart HTTP** at `/{owner}/{repo}.git`
  - `git-upload-pack` protocol v2 (`ls-refs`, `fetch` with shallow/deepen,
    incremental fetch, unborn HEAD, annotated-tag peeling) and v0
  - `git-receive-pack` v0 with `report-status`, sideband framing, and
    fast-forward enforcement (non-fast-forward refs are refused per-ref while
    fast-forward refs in the same push still apply)
  - Full pack reading/writing (SHA-1, version 2, OFS/REF delta resolution,
    thin packs) and byte-exact commit/tree/tag round-trips
- **REST v3** under `/api/v3` — repositories, branches, commits, git refs,
  contents (create/update/delete with stale-sha 409), labels, issues,
  comments, and pull requests (create, files, squash merge with conflict
  detection), with GitHub-style pagination via `Link: rel="next"`,
  `X-GitHub-Request-Id` on every reply, and JSON error bodies
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node`,
  `__type` introspection, issue/PR connections with cursor pagination,
  and the `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, and `addComment` mutations; batched operation
  documents are answered in order
- **MCP** at `/mcp` — Streamable HTTP JSON-RPC 2.0 with `server/discover`
  (modern 2026-07-28 era) and legacy `initialize` support; tools
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, and `merge_pull_request`, all acting on the same
  store as REST and GraphQL

## Layout

- `main.ts` — the harness lifecycle: bind an ephemeral port, register it with
  the environment, poll until done, exit 0 (kept as the starter ships it)
- `app.ts` — the whole forge: git object store and pack codec, HTTP server,
  REST, GraphQL, and MCP handlers
- `LICENSE` — MIT

## Determinism

Server-created timestamps come from a deterministic counter, never the wall
clock, so a replay leaves the same state export byte-for-byte.
