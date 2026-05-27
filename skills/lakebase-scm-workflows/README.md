# lakebase-scm-workflows

Opinionated git-to-Lakebase branch-pairing workflows. The agent surface for the same Node.js scripts that the [`databricks-solutions/lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) calls from its VS Code/Cursor commands — one canonical executable surface, two presentation layers.

This README is the human-facing overview. The agent's operating contract — when `.env` matters, how the git hooks behave, the credential single-seam, concrete code patterns — lives in [`SKILL.md`](SKILL.md).

> Composes on top of the dev-hub skill [`databricks-lakebase`](https://github.com/databricks/databricks-agent-skills) (Lakebase Postgres CLI basics). It does not shadow it.

## Prerequisites

The control plane and data plane are owned by other Databricks artifacts. Install/configure them once before using this skill:

- `databricks postgres ...` CLI — documented by the dev-hub skill [`databricks-lakebase`](https://github.com/databricks/databricks-agent-skills). Install via `databricks aitools install databricks-lakebase`.
- `@databricks/lakebase` npm package — drop-in `pg.Pool` with OAuth refresh.
- `@databricks/appkit` npm package — Lakebase plugin and OBO (`asUser(req)`).

## Installing the substrate

For a JS/TS host (extension, Node service) that imports substrate functions, depend on this repo via a git URL until the npm-publish path settles:

```jsonc
// host package.json
"dependencies": {
  "@databricks-solutions/lakebase-app-dev-kit":
    "github:databricks-solutions/lakebase-app-dev-kit#<commit-sha-or-tag>"
}
```

Pin to a sha. `prepare` builds `dist/` on install so consumers can import from the package name.

For agent use (running `node scripts/lakebase/<verb>.js` directly), clone this repo and run `npm install`. Same `prepare` build runs.

## Operations

Each operation is a CLI bin invocation that returns JSON on stdout. JS callers can import the same functions from the package.

- `create-project` — bootstrap a fresh Lakebase-paired project
- `schema-diff` — parent-aware diff between two Lakebase branches
- `branch-create` / `branch-delete` — Lakebase branch lifecycle
- `create-paired-branch` / `delete-paired-branch` / `checkout-paired` / `sync-env-to-current-branch` — paired ops that keep git + Lakebase + `.env` in lockstep
- `get-endpoint` / `ensure-endpoint` / `get-credential` — branch endpoint + raw token/email
- `query-branch-schema` / `query-branch-tables` — live pg introspection
- `get-project-info` — project metadata (uid, display name, state)
- `create-pull-request` / `get-pull-request` / `merge-pull-request` / `merge-paired-pull-request` — PR flow
- `get-pull-request-reviews` / `get-pull-request-files` / `get-pull-request-comments` / `list-issue-comments` / `list-workflow-runs` — PR introspection

## Under the covers

What the substrate does on your behalf, in user-journey order. You don't invoke these primitives directly — the agent does, in response to the prompts in [How to use](#how-to-use). The exception is `create-project`, which is a one-shot bootstrap you can also run yourself via the `lakebase-create-project` bin (see the CLI cheat sheet).

### 1. Create-project

End-to-end project bootstrap — the first thing you'll touch. This is the one operation you may also run yourself via the `lakebase-create-project` bin; the agent prompt in [How to use](#how-to-use) flow 1 is the conversational equivalent.

When create-project finishes you get a scaffolded layout shaped like:

```
~/code/proj-checkout/                      ← local clone (parent dir is your choice)
  src/                                     ← language-specific scaffold (Java/Kotlin/Python/Node)
  db/migrations/                           ← Flyway / Alembic migrations land here
  .env.example                             ← committed; .env never is
  .githooks/                               ← post-checkout (refresh DSN), prepare-commit-msg (embed schema diff)
  .github/workflows/
    pr.yml                                 ← schema diff + tests on every PR
    merge.yml                              ← migrate parent on merge
  .tdd/                                    ← lakebase-tdd-workflows scaffold (opt-out via --enable-tdd false)
  README.md, .gitignore, package.json/pom.xml/pyproject.toml, ...
```

Eleven steps run in order: GitHub repo creation, repo-visibility wait, clone or git-init, Lakebase project creation, default-branch resolution, language scaffold (Spring Initializr for Java/Kotlin, static templates for Python/Node), CI secrets sync, self-hosted runner setup (or GitHub-hosted), initial commit + push, and a health check. The non-fatal steps (secrets sync, runner setup, hook verification) collect into a warnings list rather than aborting. Hard-fatal errors (GitHub repo creation, Lakebase project creation, git push) abort and roll nothing back — manual cleanup is on you.

### 2. Branch lifecycle

Once the project exists, every piece of feature work starts by cutting a paired branch. Git-side operations (`git branch`, `git checkout`) stay with you and your IDE; this is the matching Lakebase-side that gives the branch its own database.

**Parent resolution.** When the agent creates a branch, it picks the parent in this order: an explicit override you specified ("branch from prod for this hotfix"), then a "branch I'm currently on" hint (git-like fork semantics), then the project's default branch (usually `production`). The "current branch" hint is ignored if it equals the target.

**Names.** Whatever you call the branch in conversation gets sanitized to a Lakebase id — lowercase, alphanumeric + hyphens, 3–63 chars. The substrate accepts a uid, the sanitized name, or the full resource path interchangeably when looking the branch up later.

**Idempotency.** Asking to create a branch that already exists returns the existing one unchanged. Deletion is not idempotent — asking to delete a branch that doesn't exist surfaces an error to you rather than silently succeeding.

### 3. Endpoint + credential

With a branch in hand, the next step is to connect to its database. The agent mints a Lakebase credential for that branch on demand — short-lived OAuth token, scoped to that branch only.

When it needs a DSN string (for `psql`, Flyway, Alembic, etc.) it gets one shaped like `postgresql://...`. When it needs a connection pool from JS/TS code, it gets a `pg.Pool` with auto-refresh built in. When it needs raw endpoint metadata (host + provisioning state), it gets that without touching credentials.

All of this funnels through one substrate helper — the single credential-minting seam — so a CI grep guard can detect any second code path trying to bypass it. You don't need to think about this; it just means there's exactly one place to look when credential issues arise.

### 4. Schema introspection

Once you're connected, you may want to see the current shape of the branch. The agent queries `information_schema` over the branch's DSN and returns the live tables and columns.

Skips `flyway_schema_history` by default — that table is migration metadata, not schema content. Returns an empty list when the branch is still provisioning (the endpoint has no host yet); the agent polls until it's ready.

### 5. Schema-diff

When you're ready to share work, the agent compares your branch against its parent — the branch's `sourceBranchId` in Lakebase metadata — so a feature branch forked from `staging` diffs against `staging`, not against `production`. When the source can't be resolved, falls back to the project's default branch.

The diff comes back as a structured summary: tables added / removed / modified, columns added / removed / type-changed, and an `inSync` boolean for the whole branch. You'd ask: "show me the diff" or "what changed since I forked." The `prepare-commit-msg` hook calls this automatically on a feature branch's first commit so the diff lands in the PR body for review.

## How to use

Four flows — shown as what you'd prompt your agent to do, using a running cart-checkout example (a project called `proj-checkout`, branch `feature-add-orders`). The bins listed in the CLI cheat sheet are also valid direct entry points; the prompts here are how you'd ask without remembering flags.

### 1. Bootstrap a new Lakebase-paired project

> "Create a new Lakebase-paired project called `proj-checkout` for the checkout flow. Use Java, a self-hosted runner, my GitHub org `my-org`, and the Databricks workspace at `https://<workspace>.cloud.databricks.com`."

The agent runs `lakebase-create-project` under the hood. When it returns you have a GitHub repo at `my-org/proj-checkout`, a Lakebase project with `production` as the default branch, a local clone with the language scaffold, `.github/workflows/{pr,merge}.yml`, `.githooks/` (post-checkout + prepare-commit-msg), `.env.example`, and `.tdd/` (the TDD workflow scaffold). Initial commit pushed, CI auth secrets synced, runner registered.

Add "skip the .tdd scaffold" to the prompt to opt out for projects that won't use `lakebase-tdd-workflows`.

### 2. Cut a feature branch and inspect schema-diff against the parent

> "Cut a Lakebase feature branch off `staging` called `feature-add-orders`, switch git to it, apply the new migration at `db/migrations/V003__add_orders.sql`, and show me the schema diff against staging."

The agent cuts the paired Lakebase branch, runs `git checkout -b feature-add-orders` (the post-checkout hook refreshes `.env`), pipes the migration through `lakebase-get-connection --output dsn`, and prints the diff from `lakebase-schema-diff`. The diff is JSON: tables added/removed/modified, columns added/removed/changed, an `inSync` boolean.

### 3. Open a PR with the schema-diff embedded in the body

> "Open a PR from `feature-add-orders` to `staging` for `my-org/proj-checkout` titled 'Add orders table'. Include the schema diff in the body."

In most cases you don't even need to ask — the `prepare-commit-msg` hook (installed by `create-project`) already writes the schema diff into the first commit on a feature branch, so `gh pr create` or the GitHub UI picks it up automatically. The prompt above is for when you want the agent to do it programmatically (catching drift between PR-open and PR-merge by re-running the diff is the job of CI's `pr.yml`).

### 4. Recover when a checkout left the DSN pointing at the wrong branch

Happens when the post-checkout hook is missing, disabled, or you switched branches outside git (e.g. via an IDE that skipped hooks). The DSN in `.env` still points at the previous branch.

> "My `.env` DSN looks stale — refresh it to point at the Lakebase branch matching the git branch I'm currently on."

The agent reads the current git branch, calls `lakebase-get-connection --output dsn --write-env` for that branch, and confirms the new `DATABASE_URL`. If you hit this often, ask: "Reinstall the git hooks" — that runs `bash .githooks/install.sh`.

## CLI cheat sheet

| Bin | Purpose |
|---|---|
| `lakebase-create-project` | End-to-end Lakebase + GitHub project bootstrap (see flow 1). |
| `lakebase-get-connection` | Mint a DSN string (`--output dsn`) or pg.Pool (`--output pool`) against any branch. Add `--write-env` to refresh `.env`. |
| `lakebase-schema-diff` | Parent-aware schema diff between any branch and its parent (or a comparison override). |
| `lakebase-github-token` | Resolve the GitHub token via the same auth chain CI uses. Useful for debugging permission issues. |
| `lakebase-migrate` | Apply / rollback / status / list schema migrations against a branch. |
| `lakebase-mcp-server` | Stdio MCP server exposing every script as an MCP tool — for Claude Desktop / OpenAI Codex consumers. |

## Composition

- **TDD on Lakebase-paired projects**: paired with [`lakebase-tdd-workflows`](../lakebase-tdd-workflows/README.md). This skill owns branch + schema + PR plumbing; TDD-workflows layers experiment / cycle / synthesis on top.
- **Inside VS Code/Cursor**: the [`lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) consumes the same substrate via npm dep — same operations, different presentation layer.
