# lakebase-app-dev-kit

Lakebase-backed application development kit. The shared foundation that the [`lakebase-scm-extension`](https://github.com/databricks-solutions/lakebase-scm-extension) (VS Code/Cursor) and coding agents – Claude Code (terminal), Claude Desktop, OpenAI Foundry, Cursor, and Databricks Genie Code – all consume. One canonical implementation; multiple presentation layers and workflow-domain skills.

**Workflow domains** (kit-authored, one skill each, hosted under `skills/`):
- **`lakebase-scm-workflows`** – paired-branch source control, schema diff, PR flow, runner setup. (Today.)
- **`lakebase-release-workflows`** – branching + release methodology for Lakebase-paired projects.
- **`lakebase-tdd-workflows`** – test-driven development against paired branches. (Coming – FEIP-7066.)
- Future domains include deploying to Databricks Apps and beyond.

**Vendored upstream skills** (also under `skills/`, synced from [`databricks/devhub`](https://github.com/databricks/devhub/tree/main/.agents/skills)):
- **`databricks-core`** – CLI basics, authentication, profile selection. Parent skill referenced by `databricks-lakebase`.
- **`databricks-lakebase`** – canonical agent reference for the `databricks postgres` CLI surface (project / branch / endpoint / database resource shapes, name formats, "never delete the production branch" rule, discovery via `-h`).

The vendored skills are read-only mirrors of upstream. To pull the latest, run `bash scripts/sync-devhub-skills.sh` and commit any diff in a focused PR. Kit-authored skills wrap the operations; vendored skills document the CLI surface those operations are built on. Agents that consume the kit (e.g. via `install.sh`) inherit both layers.

The "app dev" framing covers applications, services, libraries, and any other software that uses Lakebase – including projects deployed to Databricks Apps.

## What this is

- **`scripts/`** – Node/TypeScript modules that implement the operations: GitHub auth + repo + runner + secrets, Lakebase get-connection + branch lifecycle + schema-diff + create-project + scaffold, git wrappers, and shared utilities. Each has CLI and module entry points.
- **`skills/<domain>/SKILL.md`** – Per-workflow-domain agent surface. A coding agent reads this and drives the same scripts the extension does.
- **`apps/mcp-server/`** – Single MCP server exposing every skill's tools to MCP-capable agents (Claude Desktop, OpenAI Codex, Cursor-via-MCP).
- **`tools/openai-foundry/`** – Pre-rendered OpenAI Foundry / Codex tool spec covering the same tool surface.
- **`templates/`** – Project templates the kit ships into newly-bootstrapped Lakebase-paired projects.
- **`tests/`** – Vitest BDD tests. Live Lakebase paths skip cleanly when `LAKEBASE_TEST_*` env vars aren't set.

## Single-seam credential handoff

Two narrow auth seams, both enforced by CI grep guards:

- **`scripts/lakebase/get-connection.ts`** is the only path that mints Lakebase credentials. Every other workflow op calls `getConnection()`. See [skills/lakebase-scm-workflows/references/get-connection.md](skills/lakebase-scm-workflows/references/get-connection.md).
- **`scripts/github/auth.ts`** is the only path that resolves a GitHub token. Fallback chain: `GITHUB_TOKEN` env → VS Code `getSession` (in the extension host only) → `gh auth token`. See [skills/lakebase-scm-workflows/references/github-auth.md](skills/lakebase-scm-workflows/references/github-auth.md).

When adding a code path that needs Lakebase credentials or a GitHub token, call these two functions. Adding a second call site fails the CI grep guard.

## Install

For agent use (running `node scripts/lakebase/<verb>.js` directly):

```bash
git clone https://github.com/databricks-solutions/lakebase-app-dev-kit
cd lakebase-app-dev-kit
npm install   # prepare script builds dist/
```

For a JS/TS host (extension, Node service) that imports substrate functions, depend on this repo via a git URL. npm publish is gated on org/scope/runner questions and intentionally deferred:

```jsonc
// host package.json
"dependencies": {
  "@databricks-solutions/lakebase-app-dev-kit":
    "github:databricks-solutions/lakebase-app-dev-kit#<commit-sha-or-tag>"
}
```

Pin to a sha for reproducibility. `prepare` builds `dist/` on install.

### For coding agents

`install.sh` at the repo root copies the canonical `skills/lakebase-scm-workflows/` tree into the path each agent reads from. Auto-detects installed agents; `--tools` overrides. Mirrors the pattern in [`databricks-solutions/ai-dev-kit`](https://github.com/databricks-solutions/ai-dev-kit).

```bash
# Auto-detect installed agents, prompt to pick
bash <(curl -sL https://raw.githubusercontent.com/databricks-solutions/lakebase-app-dev-kit/main/install.sh)

# Specific targets
./install.sh --tools claude,cursor

# Upload skill into a Databricks workspace for Genie Code
./install.sh --install-to-genie --profile DEFAULT
```

Supported targets today: **Claude Code (terminal)** via `.claude/skills/`, **Cursor** via `.cursor/skills/`, and **Databricks Genie Code** via workspace upload. **Claude Desktop / OpenAI Codex** consume the same surface via the MCP manifest at `.mcp.json` – the server lives at `apps/mcp-server/` (built to `dist/apps/mcp-server/index.js`, also exposed as the `lakebase-mcp-server` bin). **OpenAI Foundry** consumes a pre-rendered tool-spec JSON at [`tools/openai-foundry/lakebase-app-dev-kit.tools.json`](tools/openai-foundry/lakebase-app-dev-kit.tools.json), regenerated by `python3 scripts/openai-foundry.py` from the same `apps/mcp-server/tools.ts` registry. Per-agent display metadata for OpenAI runtimes lives at `skills/lakebase-scm-workflows/agents/openai.yaml` (dev-hub convention).

The MCP server and the Foundry tool-spec generator are two presentations of one source: `apps/mcp-server/tools.ts`. Drift between them is caught by `python3 scripts/openai-foundry.py validate` in CI.

`@modelcontextprotocol/sdk` is declared as an **optional peer dependency** of this package, not a regular `dependency`. Consumers that only import the substrate's TypeScript modules (like `lakebase-scm-extension`) won't drag the MCP runtime into their `node_modules`. Anyone running the `lakebase-mcp-server` bin from a dev clone gets it via `devDependencies`; standalone bin users install it into their own project.

`manifest.json` at the repo root is a machine-readable index of every skill + its files, regenerated by `python3 scripts/skills.py` (validate in CI with `python3 scripts/skills.py validate`). Matches the shape used by [`databricks/databricks-agent-skills`](https://github.com/databricks/databricks-agent-skills).

## Imports

```ts
import { resolveGitHubToken } from "@databricks-solutions/lakebase-app-dev-kit/github";
import { getConnection, createBranch, deleteBranch } from "@databricks-solutions/lakebase-app-dev-kit/lakebase";
import { commitAndPush } from "@databricks-solutions/lakebase-app-dev-kit/git";
```

The root barrel `@databricks-solutions/lakebase-app-dev-kit` re-exports everything; sub-paths (`/github`, `/lakebase`, `/git`, `/util`) and individual modules (`/lakebase/branch-create`, etc.) are also exposed via the `exports` map.

## CLIs

The package exposes six bins (resolved relative to `node_modules/.bin/` when installed):

- `lakebase-get-connection` – mint a DSN or pg.Pool against a branch
- `lakebase-schema-diff` – parent-aware schema diff between two Lakebase branches
- `lakebase-github-token` – print/diagnose the resolved GitHub token
- `lakebase-create-project` – end-to-end Lakebase-paired project bootstrap
- `lakebase-migrate` – apply / rollback / status / list schema migrations against a branch
- `lakebase-mcp-server` – stdio MCP server exposing the tool registry

## Development

```bash
npm run build       # compile TS to dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run (hermetic; live tests skip cleanly)
npm run test:watch  # vitest --watch
npm run test:live   # see "Live integration tests" below
```

### Live integration tests

Hermetic `npm test` skips every test that needs a real Databricks workspace. To run those, use `scripts/run-live-tests.sh` (also wired as `npm run test:live`). Three modes:

| Mode | Required env + tools | What runs | Creates resources? |
|---|---|---|---|
| default (migrate) | `DATABRICKS_HOST`, `LAKEBASE_TEST_E2E=1`, authenticated `databricks` CLI, `python3`, `java`, `flyway` | `tests/bdd/migrate-live.test.ts` (alembic) + `tests/bdd/migrate-live-flyway.test.ts` | **Yes**: a `migrate-7091-<timestamp>` and a `migrate-7098-<timestamp>` Lakebase project on `$DATABRICKS_HOST`, each deleted in their suite's `afterAll()` |
| `--read-only` | `LAKEBASE_TEST_INSTANCE`, `LAKEBASE_TEST_BRANCH` | Read-only schema / endpoint / DSN suites against the configured branch | No |
| `--all` | both of the above | Everything vitest discovers when gating env is satisfied | Yes (default mode) |

```bash
# Default mode: self-provisions test projects on $DATABRICKS_HOST.
# On first run the script creates:
#   .venv-live-tests/                    (alembic + sqlalchemy + psycopg2-binary)
#   .tools-live-tests/flyway-<version>/  (Flyway Community CLI; skipped when a `flyway` is already on PATH)
# Subsequent runs reuse both.
export DATABRICKS_HOST=https://<your-workspace>.cloud.databricks.com
export LAKEBASE_TEST_E2E=1
npm run test:live
```

If your network blocks Maven Central (where the Flyway CLI is hosted), install Flyway separately (`brew install flyway`, your internal mirror, etc.) and put it on `PATH` before invoking `npm run test:live`. The script's preflight checks find the pre-installed binary and skips the download.

**Consent model.** Setting `LAKEBASE_TEST_E2E=1 + DATABRICKS_HOST` authorizes the suite to create a Lakebase project on your workspace. The helper script pauses for 5 seconds before the create call with a notice showing the workspace + project name pattern; ctrl-c aborts. Set `LAKEBASE_TEST_NO_PROMPT=1` in CI to skip the pause.

**Cleanup recovery.** Teardown retries delete up to 3 times. If a project still leaks (signal interrupt, crash before `afterAll()`, network blip), clean up manually:

```bash
databricks postgres delete-project <projectId>
```

Project names always have a timestamp suffix so re-runs and concurrent runs do not collide.

Individual gating env vars also light up subsets directly: `LAKEBASE_TEST_INSTANCE` + `LAKEBASE_TEST_BRANCH` activates the read-only live tests in any `vitest run` invocation; `LAKEBASE_TEST_INITIALIZR=1` enables the Spring Initializr live fetch; `LAKEBASE_TEST_PARENT` configures the parent for diff suites.

## Support

Databricks does not offer official support for content in this repository. For questions or bugs, please open a GitHub issue and the team will help on a best-effort basis.

## License

See [LICENSE.md](LICENSE.md).
