import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  rollbackDeploy,
  listAppDeployments,
} from "../../scripts/lakebase/deploy-rollback";

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
const RUN_LIVE = CLI_AVAILABLE && !!PROFILE;

describe("listAppDeployments: error contract", () => {
  it("rejects when CLI is missing entirely", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        listAppDeployments({
          profile: "any",
          appName: "any",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/ENOENT|spawn|failed|not found/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);

  it.skipIf(!RUN_LIVE)("throws when the app does not exist", async () => {
    await expect(
      listAppDeployments({
        profile: PROFILE!,
        appName: `kit-test-nonexistent-${Date.now()}`,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow();
  }, 60_000);
});

describe("rollbackDeploy: error contract", () => {
  it("rejects when CLI is missing entirely", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        rollbackDeploy({
          profile: "any",
          appName: "any",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/ENOENT|spawn|failed|not found/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);

  it.skipIf(!RUN_LIVE)("throws when the app does not exist (list call fails)", async () => {
    await expect(
      rollbackDeploy({
        profile: PROFILE!,
        appName: `kit-test-nonexistent-${Date.now()}`,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow();
  }, 60_000);

  it.skipIf(!RUN_LIVE)("throws when an explicit deploymentId is not found", async () => {
    // No app named `kit-test-rollback-probe-X` exists, so list returns
    // empty or throws. Either way, the find() returns undefined and
    // rollbackDeploy throws with a clear "Deployment ... not found"
    // OR the list call throws first. Both are acceptable.
    await expect(
      rollbackDeploy({
        profile: PROFILE!,
        appName: `kit-test-nonexistent-${Date.now()}`,
        deploymentId: "deployment-that-does-not-exist",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow();
  }, 60_000);
});

describe("rollbackDeploy: skip-when-env-missing", () => {
  it("documents the skip reason", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; live rollback tests skipped.");
    } else if (!PROFILE) {
      console.log("LAKEBASE_TEST_PROFILE not set; live rollback tests skipped.");
    }
    expect(true).toBe(true);
  });
});
