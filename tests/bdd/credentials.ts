/**
 * Live-test credential resolution for the substrate BDD suite.
 *
 * The substrate's live tests need a real Databricks workspace + GitHub auth +
 * (for some) a pre-existing Lakebase project / branch the test can read from.
 * Today each test file ad-hoc-reads its own env vars and emits its own skip
 * message – readable in isolation, opaque when a contributor runs the whole
 * suite and wonders "why did 22 tests skip?".
 *
 * This helper consolidates the env contract:
 *
 *   const env = requireLakebaseLiveEnv(["instance", "branch", "parent"]);
 *   describe(env ? "live-branch CRUD" : "skipped", () => { ... });
 *
 * If `env` is `undefined`, the helper prints a single setup banner to stderr
 * with copy-paste-ready export commands for the missing pieces, and the
 * caller's describe block runs as `describe.skipIf(!env)` (or analogous).
 * If the caller passes `{ throwOnMissing: true }`, it throws an
 * IntegrationSetupError instead – useful in tests that are themselves the
 * "you forgot the setup" guard (e.g. the documentation/skip-reason tests).
 *
 * Env contract (mirror of CONTRIBUTING.md):
 *   DATABRICKS_HOST              workspace URL (also read by `databricks` CLI)
 *   LAKEBASE_TEST_HOST           override for tests that want a different host
 *                                from DATABRICKS_HOST. Most live tests use
 *                                DATABRICKS_HOST; create-project E2E uses this.
 *   LAKEBASE_TEST_INSTANCE       existing Lakebase project id
 *   LAKEBASE_TEST_BRANCH         branch on the project (read-target)
 *   LAKEBASE_TEST_PARENT         branch to fork from (destructive tests)
 *   LAKEBASE_TEST_DATABASE       optional, defaults to "databricks_postgres"
 *   LAKEBASE_TEST_COMPARISON_BRANCH  optional schema-diff comparison override
 *   LAKEBASE_TEST_E2E=1          opt in to destructive create-project / etc.
 *   LAKEBASE_TEST_INITIALIZR=1   opt in to live start.spring.io fetch
 *   GITHUB_TOKEN                 GitHub PAT, OR `gh auth token` value
 */

import { execFileSync } from "node:child_process";

export type RequiredField =
  | "host"
  | "testHost"
  | "instance"
  | "branch"
  | "parent"
  | "githubToken"
  | "e2e"
  | "initializr";

export interface LakebaseLiveEnv {
  databricksHost: string;
  testHost: string;
  instance: string;
  branch: string;
  parent: string;
  database: string;
  comparisonBranch?: string;
  e2e: boolean;
  initializr: boolean;
  githubToken: string;
}

export interface RequireLiveEnvOpts {
  /** When true, throw IntegrationSetupError instead of returning undefined. */
  throwOnMissing?: boolean;
  /** Suppress the stderr banner (e.g. when the caller logs its own skip). */
  silent?: boolean;
}

/**
 * Returns the env contract when all `required` fields are present, or
 * `undefined` (printing a setup banner) when any are missing. With
 * `throwOnMissing: true`, throws instead of returning undefined.
 */
export function requireLakebaseLiveEnv(
  required: RequiredField[],
  opts: RequireLiveEnvOpts = {},
): LakebaseLiveEnv | undefined {
  const host = (process.env.DATABRICKS_HOST || "").trim();
  const testHost = (process.env.LAKEBASE_TEST_HOST || host).trim();
  const instance = (process.env.LAKEBASE_TEST_INSTANCE || "").trim();
  const branch = (process.env.LAKEBASE_TEST_BRANCH || "").trim();
  const parent = (process.env.LAKEBASE_TEST_PARENT || "").trim();
  const database = (process.env.LAKEBASE_TEST_DATABASE || "databricks_postgres").trim();
  const comparisonBranch = (process.env.LAKEBASE_TEST_COMPARISON_BRANCH || "").trim() || undefined;
  const e2e = process.env.LAKEBASE_TEST_E2E === "1";
  const initializr = process.env.LAKEBASE_TEST_INITIALIZR === "1";
  const githubToken = resolveGithubToken();

  const checks: Record<RequiredField, { ok: boolean; setupHint: string }> = {
    host: { ok: !!host, setupHint: "export DATABRICKS_HOST=https://<your-workspace>.cloud.databricks.com" },
    testHost: { ok: !!testHost, setupHint: "export LAKEBASE_TEST_HOST=$DATABRICKS_HOST" },
    instance: { ok: !!instance, setupHint: "export LAKEBASE_TEST_INSTANCE=<your-project-id>     # existing Lakebase project" },
    branch: { ok: !!branch, setupHint: "export LAKEBASE_TEST_BRANCH=<branch-name>             # any non-default branch the test can read" },
    parent: { ok: !!parent, setupHint: "export LAKEBASE_TEST_PARENT=<branch-name>             # branch to fork from for destructive tests" },
    githubToken: { ok: !!githubToken, setupHint: "export GITHUB_TOKEN=\"$(gh auth token)\"  # or a PAT" },
    e2e: { ok: e2e, setupHint: "export LAKEBASE_TEST_E2E=1                                  # opt in to destructive create-project" },
    initializr: { ok: initializr, setupHint: "export LAKEBASE_TEST_INITIALIZR=1                           # opt in to live start.spring.io fetch" },
  };

  const missing = required.filter((k) => !checks[k].ok);
  if (missing.length === 0) {
    return { databricksHost: host, testHost, instance, branch, parent, database, comparisonBranch, e2e, initializr, githubToken };
  }

  const banner = renderSetupBanner(missing, checks);
  if (opts.throwOnMissing) {
    throw new IntegrationSetupError(banner);
  }
  if (!opts.silent) {
    // eslint-disable-next-line no-console
    console.warn(banner);
  }
  return undefined;
}

/**
 * `gh auth token` first (so the contributor doesn't have to remember to
 * shell-substitute), GITHUB_TOKEN second (CI / explicit override).
 */
function resolveGithubToken(): string {
  const explicit = (process.env.GITHUB_TOKEN || "").trim();
  if (explicit) return explicit;
  try {
    const out = execFileSync("gh", ["auth", "token"], { stdio: "pipe", timeout: 5_000 }).toString().trim();
    return out;
  } catch {
    return "";
  }
}

function renderSetupBanner(
  missing: RequiredField[],
  checks: Record<RequiredField, { ok: boolean; setupHint: string }>,
): string {
  const hints = missing.map((m) => `  ${checks[m].setupHint}`).join("\n");
  return [
    "",
    "════════════════════════════════════════════════════════════════════",
    "  Live BDD setup needed – missing env",
    "════════════════════════════════════════════════════════════════════",
    `Missing: ${missing.join(", ")}`,
    "",
    "Run these once (or add to your shell rc):",
    hints,
    "",
    "Then re-run the test.",
    "════════════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

export class IntegrationSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSetupError";
  }
}
