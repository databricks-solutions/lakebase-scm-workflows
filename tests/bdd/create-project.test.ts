import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProject } from "../../scripts/lakebase/create-project.js";

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
  it("creates a Lakebase-paired local-only project end-to-end", async () => {
    const parent = mkTmp();
    const result = await createProject({
      projectName: `lbscm-test-${Date.now()}`,
      parentDir: parent,
      databricksHost:
        process.env.LAKEBASE_TEST_HOST ?? "https://workspace.cloud.databricks.com",
      createGithubRepo: false,
      language: "python",
      runnerType: "github-hosted",
    });
    expect(result.projectDir.startsWith(parent)).toBe(true);
    expect(result.lakebaseProjectId).toBeTruthy();
    expect(fs.existsSync(path.join(result.projectDir, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, "pyproject.toml"))).toBe(true);
  });
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
