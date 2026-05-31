// End-to-end live test for FEIP-7130 slice 2's three substrate primitives.
//
// Exercises generateAppYaml + generateBundleYaml + validateApp against a
// real Databricks workspace. The test composes a synthetic DeployTarget
// (referencing the live Lakebase project the driver exported), writes
// the generated app.yaml + databricks.yml + a minimal package.json into
// a tmpdir, then runs `databricks apps validate` against it. Validate's
// own gate (install + typegen + lint + typecheck + build + tests) covers
// the build phase end-to-end.
//
// Gate: LAKEBASE_TEST_E2E=1 + DATABRICKS_HOST + LAKEBASE_TEST_PROFILE +
// LAKEBASE_TEST_INSTANCE + LAKEBASE_TEST_BRANCH. The kit's live driver
// (scripts/run-all-live-tests.sh) exports all of these.
//
// No Databricks resources are created by this test; validate is a
// dry-run pre-deploy gate that hits only auth + bundle parsing. The
// Lakebase project referenced in the generated bundle does need to
// exist on the target workspace (otherwise the generated config still
// validates locally, but a future `bundle deploy` would fail). The
// driver guarantees the project exists.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAppYaml } from "../../scripts/lakebase/deploy-app-yaml";
import { generateBundleYaml } from "../../scripts/lakebase/deploy-bundle-yaml";
import { validateApp } from "../../scripts/lakebase/deploy-validate";
import { DeployTarget } from "../../scripts/lakebase/deploy-targets";

function hasCli(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

const CLI_AVAILABLE = hasCli();
const E2E = process.env.LAKEBASE_TEST_E2E === "1";
const HOST = process.env.DATABRICKS_HOST;
const PROFILE = process.env.LAKEBASE_TEST_PROFILE;
const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const RUN_LIVE = CLI_AVAILABLE && E2E && !!HOST && !!PROFILE && !!INSTANCE && !!BRANCH;

let projectDir: string;

beforeAll(() => {
  if (!RUN_LIVE) return;
  projectDir = mkdtempSync(join(tmpdir(), "deploy-e2e-live-"));
  // Minimal node project: validate's project-type detector requires
  // package.json. Scripts are no-ops so the test stays fast (~2s).
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "deploy-e2e-fixture",
        version: "0.0.0",
        scripts: {
          build: "echo 'no-op build'",
          lint: "echo 'no-op lint'",
          typecheck: "echo 'no-op typecheck'",
          test: "echo 'no-op test'",
        },
      },
      null,
      2,
    ) + "\n",
  );
});

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!RUN_LIVE)(
  "deploy slice 2 end-to-end (live, FEIP-7130)",
  () => {
    it("generated app.yaml + databricks.yml pass `databricks apps validate`", async () => {
      const target: DeployTarget = {
        workspace_profile: PROFILE!,
        workspace_path: "/Workspace/Users/integration-test/deploy-e2e",
        app_name: "deploy-e2e-app",
        lakebase_project: INSTANCE!,
        lakebase_branch: BRANCH!,
      };

      const appYaml = generateAppYaml(target);
      const bundleYaml = generateBundleYaml(target, target.app_name);
      writeFileSync(join(projectDir, "app.yaml"), appYaml);
      writeFileSync(join(projectDir, "databricks.yml"), bundleYaml);

      // Validate exercises the generated files end-to-end against the
      // real workspace's auth + bundle parsing.
      const result = await validateApp({
        workspaceRoot: projectDir,
        profile: PROFILE!,
        timeoutMs: 120_000,
      });

      if (!result.ok) {
        // Surface CLI output for debugging; matches the kit's other
        // live-test failure-reporting pattern.
        console.log("[deploy-e2e] validate stdout:\n" + result.stdout);
        console.log("[deploy-e2e] validate stderr:\n" + result.stderr);
      }

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      // Validate's signature success line. If the CLI ever changes the
      // wording, the test surfaces immediately; the assertion above on
      // exitCode is the contract, this is the human-readable signal.
      expect(result.stdout).toMatch(/validation checks passed/i);
    }, 180_000);

    it("generated bundle yaml references the live Lakebase project + branch", () => {
      const target: DeployTarget = {
        workspace_profile: PROFILE!,
        workspace_path: "/Workspace/Users/integration-test/deploy-e2e",
        app_name: "deploy-e2e-app",
        lakebase_project: INSTANCE!,
        lakebase_branch: BRANCH!,
      };

      const bundleYaml = generateBundleYaml(target, target.app_name);
      // Sanity-check the canonical resource-path shape made it through
      // with the LIVE identifiers, not placeholder values.
      expect(bundleYaml).toContain(`branch: projects/${INSTANCE}/branches/${BRANCH}`);
      expect(bundleYaml).toContain(`database: projects/${INSTANCE}/branches/${BRANCH}/databases/databricks_postgres`);
      expect(bundleYaml).toContain("permission: CAN_CONNECT_AND_CREATE");
    });
  },
);

describe("deploy slice 2 end-to-end (skip-when-env-missing)", () => {
  it("documents the skip reason when live driver vars are absent", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; deploy slice 2 live test skipped.");
    } else if (!E2E || !HOST || !PROFILE) {
      console.log("LAKEBASE_TEST_E2E=1 + DATABRICKS_HOST + LAKEBASE_TEST_PROFILE required; live test skipped.");
    } else if (!INSTANCE || !BRANCH) {
      console.log("LAKEBASE_TEST_INSTANCE + LAKEBASE_TEST_BRANCH required; live test skipped.");
    }
    expect(true).toBe(true);
  });
});
