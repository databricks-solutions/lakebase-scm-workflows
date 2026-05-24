import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProject } from "../../scripts/lakebase/create-project.js";
import { deleteLakebaseProject } from "../../scripts/lakebase/lakebase-project.js";

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

describe.skipIf(!liveE2E)("createProject — live end-to-end (LAKEBASE_TEST_E2E=1)", () => {
  // createProject does Lakebase create + branch resolve + scaffold + commit +
  // health check end-to-end. On a cold workspace it routinely takes 30-60s,
  // well past vitest's 5s default. Bump to 3 min so a transient slow Lakebase
  // create doesn't false-positive a timeout failure.
  const E2E_TIMEOUT_MS = 180_000;

  // Track every Lakebase project we create so afterEach can tear it down.
  // Without this every E2E retry leaks a project — the ones the suite ran
  // through before this guard left orphans behind for a manual reaper.
  let createdProjectIds: Array<{ id: string; host: string }> = [];

  afterEach(async () => {
    for (const { id, host } of createdProjectIds) {
      try {
        await deleteLakebaseProject({ projectId: id, host });
      } catch {
        // best-effort — leaks should be caught by reapOrphanProjects style
        // sweeps in the consumer test harness (ecom integration test).
      }
    }
    createdProjectIds = [];
  });

  it("creates a Lakebase-paired local-only project end-to-end", async () => {
    const parent = mkTmp();
    const host =
      process.env.LAKEBASE_TEST_HOST ?? "https://workspace.cloud.databricks.com";
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
    // createProject ships .env.example only; .env is gitignored and never
    // written by this flow (post-checkout hook bootstraps it on first switch).
    expect(fs.existsSync(path.join(result.projectDir, ".env.example"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(result.projectDir, "pyproject.toml"))).toBe(true);
  }, E2E_TIMEOUT_MS);
});

describe("createProject — skip-when-e2e-disabled", () => {
  it("documents the skip reason when LAKEBASE_TEST_E2E is unset", () => {
    if (liveE2E) return;
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_E2E not set — live create-project end-to-end test skipped (destructive)."
    );
    expect(liveE2E).toBe(false);
  });
});
