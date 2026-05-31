// End-to-end live test for FEIP-7130 slice 2's generateAppYaml +
// validateApp primitives.
//
// Composes the slice 2 primitives against a real Databricks workspace.
// Generates app.yaml from a synthetic DeployTarget (referencing the
// live Lakebase project the driver exported), writes it to a tmpdir
// with a minimal package.json, then runs `databricks apps validate`
// against the generated output. Validate's own gate (install +
// typegen + lint + typecheck + build + tests) covers the build phase
// end-to-end.
//
// Per ADR-0002's amendment, Lakebase apps do NOT use bundle config:
// the bundle's `database:` resource type references Database Instances
// (older product), not Lakebase Postgres Projects. So this test only
// generates app.yaml and runs validate; the bundle generator was
// removed in slice 3's rework.
//
// Gate: LAKEBASE_TEST_E2E=1 + DATABRICKS_HOST + LAKEBASE_TEST_PROFILE +
// LAKEBASE_TEST_INSTANCE + LAKEBASE_TEST_BRANCH. The kit's live driver
// (scripts/run-all-live-tests.sh) exports all of these.
//
// No Databricks resources are created by this test; validate is a
// dry-run pre-deploy gate that only hits auth + project parsing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAppYaml } from "../../scripts/lakebase/deploy-app-yaml";
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
    it("generated app.yaml passes `databricks apps validate`", async () => {
      const target: DeployTarget = {
        workspace_profile: PROFILE!,
        workspace_path: "/Workspace/Users/integration-test/deploy-e2e",
        app_name: "deploy-e2e-app",
        lakebase_project: INSTANCE!,
        lakebase_branch: BRANCH!,
      };

      writeFileSync(join(projectDir, "app.yaml"), generateAppYaml(target));

      const result = await validateApp({
        workspaceRoot: projectDir,
        profile: PROFILE!,
        timeoutMs: 120_000,
      });

      if (!result.ok) {
        console.log("[deploy-e2e] validate stdout:\n" + result.stdout);
        console.log("[deploy-e2e] validate stderr:\n" + result.stderr);
      }

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/validation checks passed/i);
    }, 180_000);

    it("generated app.yaml references the live Lakebase project + branch in env block", () => {
      const target: DeployTarget = {
        workspace_profile: PROFILE!,
        workspace_path: "/Workspace/Users/integration-test/deploy-e2e",
        app_name: "deploy-e2e-app",
        lakebase_project: INSTANCE!,
        lakebase_branch: BRANCH!,
      };

      const appYaml = generateAppYaml(target);
      // LAKEBASE_PROJECT_ID + LAKEBASE_BRANCH_ID emit as hardcoded
      // env values per the slice 2 generator. The platform-injected
      // PG* vars use valueFrom: postgres.
      expect(appYaml).toContain(`LAKEBASE_PROJECT_ID`);
      expect(appYaml).toContain(`value: "${INSTANCE}"`);
      expect(appYaml).toContain(`LAKEBASE_BRANCH_ID`);
      expect(appYaml).toContain(`value: "${BRANCH}"`);
      expect(appYaml).toContain(`valueFrom: postgres`);
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
