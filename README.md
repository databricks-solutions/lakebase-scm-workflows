# lakebase-scm-workflows

Opinionated git-Lakebase branch-pairing workflows. The shared executable surface that the [`lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) (VS Code/Cursor) and a Claude Code agent skill both consume — one canonical implementation, two presentation layers.

## What this is

- **`scripts/`** — Node/TypeScript modules that implement the operations: GitHub auth + repo + runner + secrets, Lakebase get-connection + branch lifecycle + schema-diff + create-project + scaffold, git wrappers, and shared utilities. Each has CLI and module entry points.
- **`agents/lakebase-scm-workflows/SKILL.md`** — Agent surface. A Claude Code agent reads this and drives the same scripts the extension does.
- **`templates/`** — Project templates the substrate ships into newly-bootstrapped Lakebase-paired projects.
- **`tests/`** — Vitest BDD tests. Live Lakebase paths skip cleanly when `LAKEBASE_TEST_*` env vars aren't set.

## Single-seam credential handoff

Two narrow auth seams, both enforced by CI grep guards:

- **`scripts/lakebase/get-connection.ts`** is the only path that mints Lakebase credentials. Every other workflow op calls `getConnection()`. See [docs/get-connection.md](docs/get-connection.md).
- **`scripts/github/auth.ts`** is the only path that resolves a GitHub token. Fallback chain: `GITHUB_TOKEN` env → VS Code `getSession` (in the extension host only) → `gh auth token`. See [docs/github-auth.md](docs/github-auth.md).

Drift across call sites is what produced the gh-token / VS Code session / PAT inconsistency we just unified. The grep guards keep it unified.

## Install

For agent use (running `node scripts/lakebase/<verb>.js` directly):

```bash
git clone https://github.com/databricks-solutions/lakebase-scm-workflows
cd lakebase-scm-workflows
npm install   # prepare script builds dist/
```

For a JS/TS host (extension, Node service) that imports substrate functions, depend on this repo via a git URL. npm publish is gated on org/scope/runner questions and intentionally deferred:

```jsonc
// host package.json
"dependencies": {
  "@databricks-solutions/lakebase-scm-workflow-scripts":
    "github:databricks-solutions/lakebase-scm-workflows#<commit-sha-or-tag>"
}
```

Pin to a sha for reproducibility. `prepare` builds `dist/` on install.

## Imports

```ts
import { resolveGitHubToken } from "@databricks-solutions/lakebase-scm-workflow-scripts/github";
import { getConnection, createBranch, deleteBranch } from "@databricks-solutions/lakebase-scm-workflow-scripts/lakebase";
import { commitAndPush } from "@databricks-solutions/lakebase-scm-workflow-scripts/git";
```

The root barrel `@databricks-solutions/lakebase-scm-workflow-scripts` re-exports everything; sub-paths (`/github`, `/lakebase`, `/git`, `/util`) and individual modules (`/lakebase/branch-create`, etc.) are also exposed via the `exports` map.

## CLIs

The package exposes four bins (resolved relative to `node_modules/.bin/` when installed):

- `lakebase-get-connection` — mint a DSN or pg.Pool against a branch
- `lakebase-schema-diff` — parent-aware schema diff between two Lakebase branches
- `lakebase-github-token` — print/diagnose the resolved GitHub token
- `lakebase-create-project` — end-to-end Lakebase-paired project bootstrap

## Development

```bash
npm run build       # compile TS to dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest --watch
```

Live Lakebase tests skip cleanly unless `LAKEBASE_TEST_INSTANCE`, `LAKEBASE_TEST_BRANCH`, `LAKEBASE_TEST_PARENT`, or `LAKEBASE_TEST_E2E=1` are set. The destructive end-to-end suite is gated on `LAKEBASE_TEST_E2E=1`.

## Support

Databricks does not offer official support for content in this repository. For questions or bugs, please open a GitHub issue and the team will help on a best-effort basis.

## License

See [LICENSE.md](LICENSE.md).
