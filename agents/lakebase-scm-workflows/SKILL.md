---
name: lakebase-scm-workflows
description: Opinionated git-Lakebase branch-pairing workflows for agents. Invoke when scaffolding a new Lakebase-paired project, managing branches with paired Lakebase state, diffing parent-aware schemas, opening or merging PRs that touch Lakebase, deploying through three-tier promotion CI, or any operation that the lakebase-scm-extension exposes in VS Code. This skill is the agent surface for the same executable substrate the extension consumes.
user-invocable: true
---

# Lakebase SCM Workflows

Opinionated git-to-Lakebase branch-pairing workflow operations. Agent surface for the same Node.js scripts that the [`databricks-solutions/lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) calls from its VS Code/Cursor commands. One canonical executable surface, two presentation layers.

## Prerequisites

The control plane and data plane are owned by other Databricks artifacts. Install/configure them once before using this skill:

- `databricks postgres ...` CLI — documented by the dev hub skill [`databricks-lakebase`](https://github.com/databricks/databricks-agent-skills). Install via `databricks aitools install databricks-lakebase`.
- `@databricks/lakebase` npm package — drop-in `pg.Pool` with OAuth refresh.
- `@databricks/appkit` npm package — Lakebase plugin, OBO (`asUser(req)`), and agent `ToolProvider`.

This skill does NOT shadow `databricks-lakebase` or `databricks-apps` from the dev hub. It composes on top of them.

## Installing the substrate

For agent use (running `node scripts/lakebase/<verb>.js` directly), clone this repo and run `npm install`. The `prepare` script builds `dist/` on install.

For a JS/TS host (e.g. VS Code extension, Node service) that needs to import substrate functions, depend on this repo via a git URL until the npm publish question (npm scope, JFrog runners) is settled:

```jsonc
// host package.json
"dependencies": {
  "@databricks-solutions/lakebase-scm-workflow-scripts":
    "github:databricks-solutions/lakebase-scm-workflows#<commit-sha-or-tag>"
}
```

Pin to a sha for reproducibility. The `prepare` script runs on install and emits `dist/` so consumers can import from the package name.

## Credential handoff — two helpers, one pattern

Two auth seams: one for Lakebase, one for GitHub. Both follow the same shape — single module, dynamic-runtime fallback chain, CI grep guard preventing anything else from resolving credentials directly.

### GitHub

```bash
node scripts/github/auth.js                 # prints token to stdout
node scripts/github/auth.js --diagnose      # which sources are configured

# JS callers:
const { resolveGitHubToken } = require('@databricks-solutions/lakebase-scm-workflow-scripts');
const token = await resolveGitHubToken();
```

Fallback: `GITHUB_TOKEN` env → VS Code `getSession` (ext host only, via dynamic `import('vscode')`) → `gh auth token` → clear error. Scopes: `['repo', 'workflow', 'delete_repo']`. Full docs: [docs/github-auth.md](../../docs/github-auth.md).

### Lakebase

Every workflow op that touches Lakebase resolves credentials through a single seam:

```bash
node scripts/lakebase/get-connection.js --output dsn --instance <id> --branch <name>
# -> libpq URL string (use for Flyway, Alembic, psql)

# from JS:
const { getConnection } = require('@databricks-solutions/lakebase-scm-workflow-scripts/lakebase/get-connection');
const pool = await getConnection({ output: 'pool', instance, branch });
# -> @databricks/lakebase pg.Pool with refresh-on-connect
```

DSN and Pool resolve to the same database via the same OAuth substrate. Never call `databricks postgres get-credentials` from anywhere else in your code — there is a CI grep guard that fails the build if you do.

## Operations

Each operation is a `node scripts/lakebase/<verb>.js` invocation that returns JSON on stdout.

> Operations land iteratively per the per-operation 4-phase rollout. As each section moves from TODO to documented, this list grows. Track progress in JIRA: FEIP-7058.

- `create-project` — bootstrap a fresh Lakebase-paired project (see below)
- `schema-diff` — parent-aware diff between two Lakebase branches (see below)
- `branch-create` / `branch-delete` — Lakebase branch lifecycle (see below). `branch-checkout` (post-checkout DSN refresh) — TODO, FEIP-7063a.
- `pr-create` / `pr-update` / `pr-merge` — PR flow with parent-matched Lakebase merge (TODO — FEIP-7063)
- `migrate` / `tests` / `health` / `deploy` / `runner-setup` / `secrets-sync` / `playwright-install` (TODO — FEIP-7064)

## branch lifecycle

Lakebase branch CRUD. Git-side operations (`git branch`, `git checkout`) are the agent's concern; these scripts handle the paired Lakebase side.

```bash
# Create a paired Lakebase branch — parent resolves from explicit override,
# then "branch I'm currently on" hint, then project default.
node scripts/lakebase/branch-create.js \
  --instance proj-abc --branch feature-auth-rewrite \
  [--parent staging] [--current main]
# -> { uid, name, state: "READY", sourceBranchName, isDefault }

# Delete (accepts uid, sanitized name, or full resource path)
node scripts/lakebase/branch-delete.js --instance proj-abc --branch feature-auth-rewrite
```

**Module API:**

```ts
import { createBranch, waitForBranchReady } from "@databricks-solutions/lakebase-scm-workflow-scripts";
import { deleteBranch } from "@databricks-solutions/lakebase-scm-workflow-scripts";

const branch = await createBranch({
  instance: "proj-abc",
  branch: "feature-auth-rewrite",   // sanitized to Lakebase id (lowercase, alphanumeric+hyphen, ≤63 chars, ≥3 chars)
  parentBranch: "staging",            // optional — overrides "current" hint and default
  currentBranch: "main",              // optional — git-like "fork from current" semantics
  readyTimeoutMs: 120_000,            // default: 2min poll budget
});

await deleteBranch({ instance: "proj-abc", branch: branch.uid });
```

**Parent resolution precedence** (ported from `LakebaseService.createBranch`):
1. `parentBranch` arg (explicit override — "branch from prod" / "branch from staging" hotfix)
2. `currentBranch` arg (git-like "fork from the branch you're on") — skipped if it equals the target
3. Project default branch (usually `production`)

**Idempotency:** `createBranch` returns the existing branch unchanged if one with the same sanitized name already exists. Delete is NOT idempotent — throws when the branch isn't found (caller can catch + ignore for idempotent semantics).

**Not yet ported (FEIP-7063a):** `branch-checkout` — the post-checkout DSN refresh that updates `.env` to point at the new branch's endpoint + credentials. This is the trickiest behavior in the markdown (root cause of the post-checkout.sh / lakebaseService.ts drift); deserves its own focused milestone.

## create-project

End-to-end project bootstrap: GitHub repo creation, Lakebase database creation, language-specific scaffolding (Spring Initializr for Java/Kotlin; static templates for Python/Node.js), git hooks, CI workflows, secrets sync, self-hosted runner registration, and the initial commit-and-push.

```bash
node scripts/lakebase/create-project.js \
  --project-name my-app \
  --parent-dir ~/code \
  --databricks-host https://workspace.cloud.databricks.com \
  --github-owner databricks-solutions \
  --language java \
  --runner self-hosted
# -> JSON on stdout: { projectDir, githubRepoUrl, lakebaseProjectId, lakebaseDefaultBranch, warnings }

# Local-only (no GitHub side effects):
node scripts/lakebase/create-project.js \
  --project-name my-app \
  --parent-dir ~/code \
  --databricks-host https://workspace.cloud.databricks.com \
  --no-github
```

**Inputs:**

| Flag | Default | Notes |
|---|---|---|
| `--project-name` | required | Local dir + Lakebase project id (lowercase alphanumeric + hyphens) |
| `--parent-dir` | required | Where the project folder lands |
| `--databricks-host` | required | Workspace URL |
| `--github-owner` | required unless `--no-github` | User or org |
| `--no-github` | off | Local-only mode (skips GitHub + runner) |
| `--public` | off | Make the GH repo public (default: private) |
| `--language` | `java` | `java` / `kotlin` / `python` / `nodejs` |
| `--runner` | `self-hosted` | `self-hosted` / `github-hosted` |

**Behavior:**

11-step orchestration. Each non-fatal failure (CI secrets sync, runner setup, hook/workflow verification) lands in the `warnings[]` array; the function only throws on hard-fatal errors (input validation, GitHub repo creation, Lakebase project creation, git operations, push rejection on workflow scope).

GitHub auth resolves through the unified `resolveGitHubToken` seam (FEIP-7068). Lakebase credentials route through `get-connection` (FEIP-7061). No other path mints either — both grep guards are CI-enforced.

For the BDD harness, pass a single `--json-input '{"projectName": ..., ...}'` arg — same JSON shape that the extension's ProjectCreationService accepts so both call sites can drive identical scenarios.

## schema-diff

Parent-aware schema diff between two Lakebase branches. Compares the target branch against its parent (the branch's `sourceBranchId` in Lakebase metadata) — for a feature forked from staging, that means diff vs staging, not vs production. Falls back to the project's default branch when the source can't be resolved.

```bash
node scripts/lakebase/schema-diff.js --instance <project-id> --branch <branch-id>
# -> SchemaDiffResult JSON (see below)

# Pin the comparison explicitly:
node scripts/lakebase/schema-diff.js --instance proj-abc --branch br-feature --against br-staging --pretty
```

**Output shape** (matches the extension's modal data contract):

```json
{
  "branchName": "br-feature",
  "comparisonBranchName": "br-staging",
  "timestamp": "2026-05-22T...",
  "migrations": [],
  "created": [{ "type": "TABLE", "name": "...", "columns": [...] }],
  "modified": [
    { "type": "TABLE", "name": "...",
      "columns": [...], "addedColumns": [...], "removedColumns": [...],
      "prodColumns": [...] }
  ],
  "removed": [...],
  "branchTables": [...],
  "inSync": false
}
```

`migrations` is always empty in the script output — it's a workspace-file concern, not a Lakebase-side one. The extension layer fills it in locally when rendering. `prodColumns` is named for legacy modal compatibility; it carries the parent (comparison) columns regardless of whether the comparison target is production.

**Flags:**

| Flag | Default | Notes |
|---|---|---|
| `--instance` | required | Lakebase project id |
| `--branch` | required | Target branch (diff is FOR this branch) |
| `--against` / `--comparison-branch` | resolved from metadata | Explicit parent branch |
| `--database` | `$PGDATABASE` then `"databricks_postgres"` | DB name |
| `--pretty` | minified | Pretty-print JSON |

## Composition

- **TDD on Lakebase-paired projects**: use the existing [`/driver-navigator-tdd`](../../../../.claude/skills/driver-navigator-tdd/SKILL.md) skill. This umbrella does not duplicate test-first methodology.
- **Inside VS Code/Cursor**: the [`lakebase-scm-extension`](../lakebase-scm-extension/SKILL.md) child skill maps extension commands to umbrella scripts so an agent that lands in the extension first can drive the same ops.

## See also

- Reference proposal: `~/Desktop/feip-lakebase-scm-workflows.md`
- Full operation mapping: `~/Desktop/lakebase-scm-workflows-mapping.md`
- Epic: FEIP-7058
