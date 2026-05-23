---
name: lakebase-scm-workflows
description: "Opinionated git-Lakebase branch-pairing workflows. Use when scaffolding a Lakebase-paired project, creating/deleting Lakebase branches in lockstep with git branches, diffing parent-aware schemas, opening or merging PRs that touch Lakebase, or running the same operations the lakebase-scm-extension exposes in VS Code."
compatibility: Requires databricks CLI (>= v0.294.0), git (>= 2.30), Node.js (>= 20), and @databricks-solutions/lakebase-scm-workflow-scripts
metadata:
  version: "0.1.0"
parent: databricks-lakebase
---

# Lakebase SCM Workflows

Opinionated git-to-Lakebase branch-pairing workflow operations. Agent surface for the same Node.js scripts that the [`databricks-solutions/lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) calls from its VS Code/Cursor commands. One canonical executable surface, two presentation layers.

**FIRST**: Use the parent `databricks-lakebase` skill for Lakebase Postgres CLI basics (project creation, branch concepts, connectivity). This skill composes on top of it — it does not shadow the dev-hub Lakebase skill.

## Prerequisites

The control plane and data plane are owned by other Databricks artifacts. Install/configure them once before using this skill:

- `databricks postgres ...` CLI — documented by the dev-hub skill [`databricks-lakebase`](https://github.com/databricks/databricks-agent-skills). Install via `databricks aitools install databricks-lakebase`.
- `@databricks/lakebase` npm package — drop-in `pg.Pool` with OAuth refresh.
- `@databricks/appkit` npm package — Lakebase plugin and OBO (`asUser(req)`).

## Installing the substrate

For agent use (running `node scripts/lakebase/<verb>.js` directly), clone this repo and run `npm install`. The `prepare` script builds `dist/` on install.

For a JS/TS host (extension, Node service) that imports substrate functions, depend on this repo via a git URL until the npm-publish path settles:

```jsonc
// host package.json
"dependencies": {
  "@databricks-solutions/lakebase-scm-workflow-scripts":
    "github:databricks-solutions/lakebase-scm-workflows#<commit-sha-or-tag>"
}
```

Pin to a sha. `prepare` builds `dist/` on install so consumers can import from the package name.

## Credential handoff — two helpers, one pattern

Two narrow auth seams — one for Lakebase, one for GitHub. Both follow the same shape: single module, dynamic-runtime fallback chain, CI grep guard preventing any other file from resolving credentials directly.

### GitHub

```bash
lakebase-github-token                 # print token to stdout
lakebase-github-token --diagnose      # which sources are configured

# JS callers:
const { resolveGitHubToken } = require('@databricks-solutions/lakebase-scm-workflow-scripts');
const token = await resolveGitHubToken();
```

Fallback: `GITHUB_TOKEN` env → VS Code `getSession` (extension host only, via dynamic `import('vscode')`) → `gh auth token` → clear error. Scopes: `['repo', 'workflow', 'delete_repo']`. Full docs: [references/github-auth.md](references/github-auth.md).

### Lakebase

Every workflow op that touches Lakebase resolves credentials through a single seam:

```bash
lakebase-get-connection --output dsn --instance <id> --branch <name>
# -> libpq URL string (use for Flyway, Alembic, psql)

# from JS:
const { getConnection } = require('@databricks-solutions/lakebase-scm-workflow-scripts');
const pool = await getConnection({ output: 'pool', instance, branch });
# -> @databricks/lakebase pg.Pool with refresh-on-connect
```

DSN and Pool resolve to the same database via the same OAuth substrate. Never call `databricks postgres generate-database-credential` from anywhere else in your code — there is a CI grep guard that fails the build if you do. Full docs: [references/get-connection.md](references/get-connection.md).

## Operations

Each operation is a CLI bin invocation that returns JSON on stdout. JS callers can import the same functions from the package.

> Operations land iteratively per the per-operation 4-phase rollout. Tracked in JIRA: FEIP-7058.

- `create-project` — bootstrap a fresh Lakebase-paired project
- `schema-diff` — parent-aware diff between two Lakebase branches
- `branch-create` / `branch-delete` — Lakebase branch lifecycle
- `get-endpoint` / `get-credential` — branch endpoint + raw token/email
- `query-branch-schema` / `query-branch-tables` — live pg introspection
- `get-project-info` — project metadata (uid, display name, state)
- `pr-create` / `pr-update` / `pr-merge` — PR flow (TODO — FEIP-7076)

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
import {
  createBranch,
  waitForBranchReady,
  deleteBranch,
} from "@databricks-solutions/lakebase-scm-workflow-scripts";

const branch = await createBranch({
  instance: "proj-abc",
  branch: "feature-auth-rewrite",   // sanitized to Lakebase id (lowercase, alphanumeric+hyphen, 3-63 chars)
  parentBranch: "staging",            // optional — overrides "current" hint and default
  currentBranch: "main",              // optional — git-like "fork from current" semantics
  timeoutMs: 120_000,                 // default: 2min poll budget
});

await deleteBranch({ instance: "proj-abc", branch: branch.uid });
```

**Parent resolution precedence** (ported from `LakebaseService.createBranch`):
1. `parentBranch` arg (explicit override — "branch from prod" / "branch from staging" hotfix)
2. `currentBranch` arg (git-like "fork from the branch you're on") — skipped if it equals the target
3. Project default branch (usually `production`)

**Idempotency:** `createBranch` returns the existing branch unchanged if one with the same sanitized name already exists. Delete is NOT idempotent — throws when the branch isn't found (caller can catch + ignore for idempotent semantics).

## endpoint + credential

```bash
lakebase-get-connection --output dsn --instance proj-abc --branch br-feature
# -> postgresql://... DSN

# Just the endpoint metadata (host + state):
node -e "import('@databricks-solutions/lakebase-scm-workflow-scripts').then(m => m.getEndpoint({instance:'proj-abc', branch:'br-feature'}).then(console.log))"
# -> { host: 'instance-...', state: 'ACTIVE' } | undefined

# Just the raw token + email (resolves branch path, then mints via the single seam):
const { getCredential } = require('@databricks-solutions/lakebase-scm-workflow-scripts');
const { token, email } = await getCredential({ instance, branch });
```

## schema introspection

```bash
# Live table inventory on a branch (queries information_schema via pg):
node -e "import('@databricks-solutions/lakebase-scm-workflow-scripts').then(m => m.queryBranchSchema({instance:'proj-abc', branch:'br-feature'}).then(r => console.log(JSON.stringify(r, null, 2))))"
# -> [{ name: 'users', columns: [{ name: 'id', dataType: 'uuid' }, ...] }, ...]

# Just table names:
const { queryBranchTables } = require('@databricks-solutions/lakebase-scm-workflow-scripts');
const tables = await queryBranchTables({ instance, branch });
```

Skips `flyway_schema_history` by default. Returns `[]` when the endpoint has no host yet (branch still provisioning) — caller can poll.

## create-project

End-to-end project bootstrap: GitHub repo creation, Lakebase database creation, language-specific scaffolding (Spring Initializr for Java/Kotlin; static templates for Python/Node.js), git hooks, CI workflows, secrets sync, self-hosted runner registration, and the initial commit-and-push.

```bash
lakebase-create-project \
  --project-name my-app \
  --parent-dir ~/code \
  --databricks-host https://workspace.cloud.databricks.com \
  --github-owner databricks-solutions \
  --language java \
  --runner self-hosted
# -> JSON on stdout: { projectDir, githubRepoUrl, lakebaseProjectId, lakebaseDefaultBranch, warnings }

# Local-only (no GitHub side effects):
lakebase-create-project \
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

11-step orchestration. Non-fatal failures (CI secrets sync, runner setup, hook/workflow verification) land in the `warnings[]` array. The function only throws on hard-fatal errors (input validation, GitHub repo creation, Lakebase project creation, git operations, push rejection on workflow scope).

For the BDD harness, pass a single `--json-input '{"projectName": ..., ...}'` arg — same JSON shape that the extension's ProjectCreationService accepts so both call sites can drive identical scenarios.

## schema-diff

Parent-aware schema diff between two Lakebase branches. Compares the target branch against its parent (the branch's `sourceBranchId` in Lakebase metadata) — for a feature forked from staging, that means diff vs staging, not vs production. Falls back to the project's default branch when the source can't be resolved.

```bash
lakebase-schema-diff --instance <project-id> --branch <branch-id>
# -> SchemaDiffResult JSON

# Pin the comparison explicitly:
lakebase-schema-diff --instance proj-abc --branch br-feature --against br-staging --pretty
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

## Composition

- **TDD on Lakebase-paired projects**: use the existing [`driver-navigator-tdd`](https://github.com/anthropics/) skill if available. This umbrella does not duplicate test-first methodology.
- **Inside VS Code/Cursor**: the [`lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) consumes the same substrate via npm dep — same operations, different presentation layer.

## See also

- Reference proposal: `feip-lakebase-scm-workflows.md`
- Full operation mapping: `lakebase-scm-workflows-mapping.md`
- Epic: FEIP-7058
