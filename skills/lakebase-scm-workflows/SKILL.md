---
name: lakebase-scm-workflows
description: "Opinionated git-Lakebase branch-pairing workflows. Use when scaffolding a Lakebase-paired project, creating/deleting Lakebase branches in lockstep with git branches, diffing parent-aware schemas, opening or merging PRs that touch Lakebase, or running the same operations the lakebase-scm-extension exposes in VS Code."
compatibility: Requires databricks CLI (>= v0.294.0), git (>= 2.30), Node.js (>= 20), and @databricks-solutions/lakebase-app-dev-kit
metadata:
  version: "0.1.0"
parent: databricks-lakebase
---

# lakebase-scm-workflows — agent contract

Agent-facing contract: operating rules (`.env`, git hooks, credential single-seam), concrete code patterns for each substrate primitive, and reference pointers.

For the human-facing overview (prerequisites, installation, prompts, journey, CLI cheat sheet) see [`README.md`](README.md).

**FIRST**: load the parent `databricks-lakebase` skill for Lakebase Postgres CLI basics (project / branch / endpoint shapes, name formats, "never delete the production branch" rule). This skill composes on top of it.

## Project state — when `.env` matters

The substrate API takes explicit args (`instance`, `branch`, etc.) on every public function — agents can drive every operation without a project `.env` at all. **But** when an agent is acting AS the developer in a checked-out paired project, the project's `.env` is the source of truth for "which Lakebase branch is this workspace currently paired with."

| Agent context | `.env` contract |
|---|---|
| In a checked-out paired project (Claude Code / Cursor / Genie Code on a developer's machine) | **Respect it.** Read `LAKEBASE_PROJECT_ID` to derive `instance`. After `git checkout`, call `syncEnvToCurrentBranch({ cwd })` so `.env` matches the new branch — otherwise the bundled CI scripts (`refresh-token.sh`, `flyway-migrate.sh`) and the git hooks operate on stale credentials. |
| Sandbox / no workspace (Claude Desktop, OpenAI Agent Builder, exploratory) | **Ignore it.** Pass `instance` and `branch` explicitly per call. Substrate never requires `.env`. |
| Bootstrapping a new project | **N/A.** `createProject` creates the `.env` for you as step 7. No `.env` exists before that. |

**Connection-block keys** (managed by `syncEnvToCurrentBranch` / `updateEnvConnection` / `post-checkout.sh`):

```
LAKEBASE_BRANCH_ID=feature-x
DATABASE_URL=postgresql://user%40databricks.com:tok@host:5432/databricks_postgres?sslmode=require
DB_USERNAME=user@databricks.com
DB_PASSWORD=tok
```

These four are the rewritten set on every branch switch. Anything else in `.env` is preserved verbatim.

**Project-level keys** (written once by `writeEnvFile` during project bootstrap, never rewritten):

```
DATABRICKS_HOST=https://workspace.cloud.databricks.com
LAKEBASE_PROJECT_ID=my-app
```

If you're an agent dropping into a project mid-session, read these first to know what `instance` to pass to every subsequent operation.

## Sync without an IDE — the git hooks

The construct that keeps a Lakebase branch and a git branch in sync in a plain terminal session (no extension, no explicit substrate call) is the **bundled git hooks** that `scaffoldAll` / `installHooks` drops into `.git/hooks/` during project bootstrap. They are the default-on automatic sync mechanism. Agents driving raw `git` commands inherit them for free.

| Hook | Fires on | What it does |
|---|---|---|
| `post-checkout` | `git checkout <branch>` | Reads new current branch → finds matching Lakebase branch → mints fresh credential → rewrites `.env` connection block. **The primary sync mechanism.** |
| `post-merge` | `git merge` | Runs Flyway migrations against the now-current Lakebase branch so schema catches up. |
| `pre-push` | `git push` | Schema-diff guard — surfaces unmigrated changes before remote sees them. |
| `prepare-commit-msg` | `git commit` | Embeds Lakebase branch context in commit messages so the schema-diff CI workflow can find them. |

**Practical implications for an agent:**

1. **Don't fight the hooks.** If you run `git checkout feature-x` in a paired project, `.env` auto-updates. Don't also call `syncEnvToCurrentBranch` defensively — let the hook own that side of the workflow.
2. **Hooks don't create branches.** They sync state after-the-fact. To CREATE a Lakebase branch (which has no git equivalent), use the substrate's `createPairedBranch` — it creates the Lakebase side first, then `git checkout -b` triggers the hook to populate credentials.
3. **If hooks aren't installed, re-arm them.** Some workflows clone a paired project without scaffolding (e.g. cloning someone else's checkout). The substrate's `installHooks(projectDir)` is the recovery — copies `scripts/post-checkout.sh` and siblings into `.git/hooks/` with the right permissions.
4. **For pure-API sessions (no checkout) the hooks are irrelevant.** A Claude Desktop sandbox or OpenAI Agent Builder session that just calls `getConnection({ instance, branch })` doesn't have a `.git/` to install hooks into — and doesn't need them. The hooks only matter when an agent (or human) is driving a working tree with `git` commands.

The bundled hook scripts live in `templates/project/common/scripts/`.

## Credential handoff — two helpers, one pattern

Two narrow auth seams — one for Lakebase, one for GitHub. Both follow the same shape: single module, dynamic-runtime fallback chain, CI grep guard preventing any other file from resolving credentials directly.

### GitHub

```bash
lakebase-github-token                 # print token to stdout
lakebase-github-token --diagnose      # which sources are configured
```

```ts
import { resolveGitHubToken } from "@databricks-solutions/lakebase-app-dev-kit";
const token = await resolveGitHubToken();
```

Fallback: `GITHUB_TOKEN` env → VS Code `getSession` (extension host only, via dynamic `import('vscode')`) → `gh auth token` → clear error. Scopes: `['repo', 'workflow', 'delete_repo']`. Full docs: [`references/github-auth.md`](references/github-auth.md).

### Lakebase

Every workflow op that touches Lakebase resolves credentials through a single seam:

```bash
lakebase-get-connection --output dsn --instance <id> --branch <name>
# -> libpq URL string (use for Flyway, Alembic, psql)
```

```ts
import { getConnection } from "@databricks-solutions/lakebase-app-dev-kit";
const pool = await getConnection({ output: "pool", instance, branch });
// -> @databricks/lakebase pg.Pool with refresh-on-connect
```

DSN and Pool resolve to the same database via the same OAuth substrate. Never call `databricks postgres generate-database-credential` from anywhere else in your code — a CI grep guard fails the build if you do. Full docs: [`references/get-connection.md`](references/get-connection.md).

## Operations

Concrete invocations per primitive, in user-journey order. The agent reads these to know what to call; humans see the conversational equivalent in [`README.md`'s "How to use"](README.md#how-to-use).

### 1. Create-project

End-to-end project bootstrap.

```bash
lakebase-create-project \
  --project-name proj-checkout \
  --parent-dir ~/code \
  --databricks-host https://workspace.cloud.databricks.com \
  --github-owner my-org \
  --language java \
  --runner self-hosted
# -> JSON on stdout: { projectDir, githubRepoUrl, lakebaseProjectId, lakebaseDefaultBranch, warnings }

# Local-only (no GitHub side effects):
lakebase-create-project --project-name proj-checkout --parent-dir ~/code \
  --databricks-host https://workspace.cloud.databricks.com --no-github
```

```ts
import { createProject } from "@databricks-solutions/lakebase-app-dev-kit";
const result = await createProject({
  projectName: "proj-checkout",
  parentDir: process.env.HOME + "/code",
  databricksHost: "https://workspace.cloud.databricks.com",
  githubOwner: "my-org",
  language: "java",
  runnerType: "self-hosted",
  enableTdd: true,                // default: true — lays down .tdd/ scaffold
});
```

Eleven-step orchestration. Non-fatal failures (CI secrets sync, runner setup, hook/workflow verification) land in `result.warnings[]`. Hard-fatal errors (input validation, GitHub repo creation, Lakebase project creation, git operations, push rejection on workflow scope) throw.

### 2. Branch lifecycle

Lakebase branch CRUD. Git-side operations stay with the caller; these scripts handle the paired Lakebase side.

```bash
# Create a paired Lakebase branch — parent resolves from explicit override,
# then "branch I'm currently on" hint, then project default.
node scripts/lakebase/branch-create.js \
  --instance proj-checkout --branch feature-add-orders \
  [--parent staging] [--current main]
# -> { uid, name, state: "READY", sourceBranchName, isDefault }

node scripts/lakebase/branch-delete.js --instance proj-checkout --branch feature-add-orders
```

```ts
import { createBranch, waitForBranchReady, deleteBranch }
  from "@databricks-solutions/lakebase-app-dev-kit";

const branch = await createBranch({
  instance: "proj-checkout",
  branch: "feature-add-orders",     // sanitized to Lakebase id (lowercase, alphanumeric+hyphen, 3-63 chars)
  parentBranch: "staging",            // optional — overrides "current" hint and default
  currentBranch: "main",              // optional — git-like "fork from current" semantics
  timeoutMs: 120_000,                 // default: 2min poll budget
});

await deleteBranch({ instance: "proj-checkout", branch: branch.uid });
```

**Parent resolution precedence:**
1. `parentBranch` arg (explicit override — "branch from prod" / "branch from staging" hotfix)
2. `currentBranch` arg (git-like "fork from the branch you're on") — skipped if it equals the target
3. Project default branch (usually `production`)

**Idempotency.** `createBranch` returns the existing branch unchanged if one with the same sanitized name already exists. Delete is NOT idempotent — throws when the branch isn't found.

### 3. Endpoint + credential

```bash
lakebase-get-connection --output dsn --instance proj-checkout --branch feature-add-orders
# -> postgresql://... DSN

lakebase-get-connection --output dsn --instance proj-checkout --branch feature-add-orders --write-env
# -> Same DSN, but also rewrites .env DATABASE_URL block (recovery from broken post-checkout hook)
```

```ts
import { getConnection, getEndpoint, getCredential }
  from "@databricks-solutions/lakebase-app-dev-kit";

// DSN string (for Flyway, Alembic, psql):
const { dsn } = await getConnection({ output: "dsn", instance, branch });

// Connection pool with OAuth refresh:
const pool = await getConnection({ output: "pool", instance, branch });

// Just the endpoint metadata (host + state):
const endpoint = await getEndpoint({ instance, branch });
// -> { host: "instance-...", state: "ACTIVE" } | undefined

// Just the raw token + email (resolves branch path, then mints via the single seam):
const { token, email } = await getCredential({ instance, branch });
```

### 4. Schema introspection

```bash
node -e "import('@databricks-solutions/lakebase-app-dev-kit').then(m => m.queryBranchSchema({instance:'proj-checkout', branch:'feature-add-orders'}).then(r => console.log(JSON.stringify(r, null, 2))))"
# -> [{ name: 'users', columns: [{ name: 'id', dataType: 'uuid' }, ...] }, ...]
```

```ts
import { queryBranchSchema, queryBranchTables }
  from "@databricks-solutions/lakebase-app-dev-kit";

const schema = await queryBranchSchema({ instance, branch });
const tables = await queryBranchTables({ instance, branch });
```

Skips `flyway_schema_history` by default. Returns `[]` when the endpoint has no host yet (branch still provisioning) — caller can poll.

### 5. Schema-diff

Parent-aware schema diff between two Lakebase branches. Compares the target branch against its parent (the branch's `sourceBranchId` in Lakebase metadata) — for a feature forked from `staging`, that means diff vs `staging`, not vs `production`. Falls back to the project's default branch when the source can't be resolved.

```bash
lakebase-schema-diff --instance proj-checkout --branch feature-add-orders
# -> SchemaDiffResult JSON

lakebase-schema-diff --instance proj-checkout --branch feature-add-orders --against staging --pretty
```

```ts
import { getSchemaDiff } from "@databricks-solutions/lakebase-app-dev-kit";

const diff = await getSchemaDiff({
  instance: "proj-checkout",
  branch: "feature-add-orders",
  // against: "staging",   // optional pin; otherwise auto-resolves from sourceBranchId
});
```

**Output shape** (matches the extension's modal data contract):

```json
{
  "branchName": "feature-add-orders",
  "comparisonBranchName": "staging",
  "timestamp": "2026-05-22T...",
  "migrations": [],
  "created":  [{ "type": "TABLE", "name": "...", "columns": [...] }],
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

`migrations` is always empty in the script output — that's a workspace-file concern, not a Lakebase-side one. The extension layer fills it in locally when rendering. `prodColumns` is named for legacy modal compatibility; it carries the parent (comparison) columns regardless of whether the comparison target is production.

### PR flow

```ts
import {
  createPullRequest, getPullRequest, mergePullRequest, mergePairedPullRequest,
  getPullRequestReviews, getPullRequestFiles, getPullRequestComments,
} from "@databricks-solutions/lakebase-app-dev-kit";

// Open a PR with the current branch's schema diff embedded in the body.
const diff = await getSchemaDiff({ instance: "proj-checkout", branch: "feature-add-orders" });
await createPullRequest({
  owner: "my-org",
  repo: "proj-checkout",
  base: "staging",
  head: "feature-add-orders",
  title: "Add orders table",
  body: [
    "## Summary",
    "Introduces the `orders` table to support the checkout flow.",
    "",
    "## Schema diff (vs staging)",
    "```json",
    JSON.stringify(diff, null, 2),
    "```",
  ].join("\n"),
});
```

`mergePairedPullRequest` merges the git PR AND tears down the Lakebase feature branch in lockstep. Use it for clean post-merge state on paired projects.

## References

- [`references/get-connection.md`](references/get-connection.md) — Lakebase credential seam (DSN + Pool, OAuth refresh, fallback chain).
- [`references/github-auth.md`](references/github-auth.md) — GitHub token seam (env → VS Code session → `gh auth token`).
- Parent skill: [`databricks-lakebase`](https://github.com/databricks/databricks-agent-skills) — Postgres CLI surface this skill composes on.
- Sibling skill: [`../lakebase-tdd-workflows/SKILL.md`](../lakebase-tdd-workflows/SKILL.md) — TDD workflow on paired branches; consumes `createBranch`, `getSchemaDiff`, `getConnection` from this skill.
