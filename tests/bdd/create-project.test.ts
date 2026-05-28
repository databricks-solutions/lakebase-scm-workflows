import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProject } from "../../scripts/lakebase/create-project.js";
import { deleteLakebaseProject } from "../../scripts/lakebase/lakebase-project.js";

/**
 * Resolve the destructive test's target host. Precedence:
 *   1. `LAKEBASE_TEST_HOST` – explicit override (e.g. for CI where the
 *      profile mechanism isn't available).
 *   2. `DATABRICKS_CONFIG_PROFILE` – runs `databricks auth env --profile`
 *      and reads back DATABRICKS_HOST. Matches the substrate's existing
 *      profile-aware behavior so contributors who already have a working
 *      profile don't need to also set LAKEBASE_TEST_HOST.
 *   3. null – caller should skip the test.
 *
 * NB: previously this fell back to a hardcoded `workspace.cloud.databricks.com`
 * placeholder, which DNS-failed in every run. That fallback masked the
 * "no host configured" case as a misleading network error; surfacing
 * null lets the suite skip cleanly with a clear message.
 */
function resolveTestHost(): string | null {
  if (process.env.LAKEBASE_TEST_HOST) return process.env.LAKEBASE_TEST_HOST;
  const profile = process.env.DATABRICKS_CONFIG_PROFILE;
  if (!profile) return null;
  try {
    const raw = execFileSync("databricks", ["auth", "env", "--profile", profile], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    const env = JSON.parse(raw) as { env?: Record<string, string> };
    const host = env.env?.DATABRICKS_HOST?.replace(/\/+$/, "");
    return host ?? null;
  } catch {
    return null;
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-cp-"));
  tmpDirs.push(dir);
  return dir;
}

// End-to-end create-project is destructive (creates GitHub repos + Lakebase
// projects + ~250MB runner downloads). Live BDD equivalence requires a
// dedicated test workspace + GitHub org; behind LAKEBASE_TEST_E2E=1.
// This suite only covers the early validation + local-only first steps
// that don't hit external services.

describe("createProject input validation", () => {
  it("throws when GitHub is enabled but owner is missing", async () => {
    await expect(
      createProject({
        projectName: "test-app",
        parentDir: mkTmp(),
        databricksHost: "https://workspace.cloud.databricks.com",
        createGithubRepo: true,
      })
    ).rejects.toThrow(/GitHub owner is required/);
  });

  it("throws when the target directory already exists (local-only mode)", async () => {
    const parent = mkTmp();
    const projectDir = path.join(parent, "existing-app");
    fs.mkdirSync(projectDir);
    await expect(
      createProject({
        projectName: "existing-app",
        parentDir: parent,
        databricksHost: "https://workspace.cloud.databricks.com",
        createGithubRepo: false,
      })
    ).rejects.toThrow(/Directory already exists/);
  });
});

const liveE2E = process.env.LAKEBASE_TEST_E2E === "1";
// Lazily evaluated so the resolver doesn't fire (and possibly shell out)
// at module-import time when the suite is skipped anyway.
const e2eHost = liveE2E ? resolveTestHost() : null;
const e2eReady = liveE2E && !!e2eHost;

describe.skipIf(!e2eReady)("createProject – live end-to-end (LAKEBASE_TEST_E2E=1)", () => {
  // createProject does Lakebase create + branch resolve + scaffold + commit +
  // health check end-to-end. On a cold workspace it routinely takes 30-60s,
  // well past vitest's 5s default. Bump to 3 min so a transient slow Lakebase
  // create doesn't false-positive a timeout failure.
  const E2E_TIMEOUT_MS = 180_000;

  // Track every Lakebase project we create so afterEach can tear it down.
  // Without this every E2E retry leaks a project – the ones the suite ran
  // through before this guard left orphans behind for a manual reaper.
  let createdProjectIds: Array<{ id: string; host: string }> = [];

  afterEach(async () => {
    for (const { id, host } of createdProjectIds) {
      try {
        await deleteLakebaseProject({ projectId: id, host });
      } catch {
        // best-effort – leaks should be caught by reapOrphanProjects style
        // sweeps in the consumer test harness (ecom integration test).
      }
    }
    createdProjectIds = [];
  });

  it("creates a Lakebase-paired local-only project end-to-end", async () => {
    const parent = mkTmp();
    // e2eHost is guaranteed non-null here – describe.skipIf gates on it.
    const host = e2eHost!;
    const projectName = `lbscm-test-${Date.now()}`;
    // Pre-register so afterEach tears it down even on assertion failure.
    createdProjectIds.push({ id: projectName, host });

    const result = await createProject({
      projectName,
      parentDir: parent,
      databricksHost: host,
      createGithubRepo: false,
      language: "python",
      runnerType: "github-hosted",
    });
    expect(result.projectDir.startsWith(parent)).toBe(true);
    expect(result.lakebaseProjectId).toBeTruthy();
    // createProject ships BOTH .env.example (tracked template) AND a seeded
    // .env (gitignored, populated with LAKEBASE_PROJECT_ID + DATABRICKS_HOST
    // from the create flow). The seed avoids the gated-hook chicken-and-egg:
    // post-checkout would otherwise bail on empty LAKEBASE_PROJECT_ID and
    // never refresh .env on subsequent checkouts. Secrets (JWT, DB_PASSWORD,
    // DATABASE_URL) stay deferred to the hook on first checkout. See
    // scaffold.ts deployEnv() for the rationale.
    expect(fs.existsSync(path.join(result.projectDir, ".env.example"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, "pyproject.toml"))).toBe(true);

    // The seeded .env contains the non-secret context only – the project id +
    // workspace host. Secret fields stay empty/absent until the post-checkout
    // hook fills them on first branch switch.
    const seededEnv = fs.readFileSync(path.join(result.projectDir, ".env"), "utf-8");
    expect(seededEnv).toContain(`LAKEBASE_PROJECT_ID=${result.lakebaseProjectId}`);
    expect(seededEnv).toContain("DATABRICKS_HOST=");
  }, E2E_TIMEOUT_MS);
});

describe("createProject – skip-when-e2e-disabled", () => {
  it("documents the skip reason when LAKEBASE_TEST_E2E is unset", () => {
    if (liveE2E) return;
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_E2E not set – live create-project end-to-end test skipped (destructive)."
    );
    expect(liveE2E).toBe(false);
  });

  it("documents the skip reason when no host is resolvable (LAKEBASE_TEST_HOST + DATABRICKS_CONFIG_PROFILE both missing)", () => {
    if (!liveE2E || e2eHost) return;
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_E2E=1 but no test host resolvable – set LAKEBASE_TEST_HOST explicitly " +
        "or DATABRICKS_CONFIG_PROFILE (the test will run `databricks auth env --profile` to derive the host)."
    );
    expect(e2eHost).toBeNull();
  });
});
