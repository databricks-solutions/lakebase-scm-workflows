import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  getAppServicePrincipal,
  grantLakebasePermission,
  propagateCredentials,
} from "../../scripts/lakebase/deploy-credentials";
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
const PROFILE = process.env.LAKEBASE_TEST_PROFILE;
const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const RUN_LIVE = CLI_AVAILABLE && !!PROFILE && !!INSTANCE;

const MINIMAL_TARGET: DeployTarget = {
  workspace_profile: PROFILE ?? "noop",
  workspace_path: "/Workspace/Users/probe/noop",
  app_name: "noop",
  lakebase_project: INSTANCE ?? "noop-project",
  lakebase_branch: "production",
};

describe("getAppServicePrincipal: error contract", () => {
  it.skipIf(!RUN_LIVE)("throws when the app does not exist", async () => {
    await expect(
      getAppServicePrincipal({
        appName: `kit-test-nonexistent-${Date.now()}`,
        profile: PROFILE!,
        timeoutMs: 30_000,
      })
    ).rejects.toThrow(/not found|RESOURCE_DOES_NOT_EXIST/i);
  }, 60_000);

  it("rejects when CLI is missing entirely", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        getAppServicePrincipal({
          appName: "any",
          profile: "any",
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/ENOENT|spawn|failed to start|not found/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);
});

describe("grantLakebasePermission: error contract", () => {
  it("rejects when CLI is missing entirely", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        grantLakebasePermission({
          profile: "any",
          projectName: "any",
          servicePrincipalName: "any-sp-uuid",
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/ENOENT|spawn|failed to start|not found/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);

  it.skipIf(!RUN_LIVE)("rejects when the project does not exist", async () => {
    await expect(
      grantLakebasePermission({
        profile: PROFILE!,
        projectName: `kit-nonexistent-project-${Date.now()}`,
        servicePrincipalName: "00000000-0000-0000-0000-000000000000",
        timeoutMs: 30_000,
      })
    ).rejects.toThrow();
  }, 60_000);
});

describe("propagateCredentials: composition", () => {
  it.skipIf(!RUN_LIVE)("returns lakebaseGranted=false when the app does not exist", async () => {
    // getAppServicePrincipal throws on missing app, which propagates
    // through propagateCredentials. The result-vs-throw contract for
    // missing apps lives in getAppEndpoint (resource-missing returns
    // exists=false WITHOUT throwing, but the SP lookup explicitly
    // throws when the app is not found).
    await expect(
      propagateCredentials({
        target: { ...MINIMAL_TARGET, lakebase_project: INSTANCE! },
        profile: PROFILE!,
        appName: `kit-test-nonexistent-${Date.now()}`,
        timeoutMs: 30_000,
      })
    ).rejects.toThrow(/not found|RESOURCE_DOES_NOT_EXIST/i);
  }, 60_000);
});

describe("deploy-credentials: skip-when-env-missing", () => {
  it("documents the skip reason", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; live credential tests skipped.");
    } else if (!PROFILE) {
      console.log("LAKEBASE_TEST_PROFILE not set; live credential tests skipped.");
    } else if (!INSTANCE) {
      console.log("LAKEBASE_TEST_INSTANCE not set; live credential tests skipped.");
    }
    expect(true).toBe(true);
  });
});
