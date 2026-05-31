import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteAppEndpoint,
  ensureAppEndpoint,
  getAppEndpoint,
} from "../../scripts/lakebase/deploy-app-endpoint";

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
// Heavy live deploy tests are gated separately. ensureAppEndpoint
// actually deploys to the workspace, which costs minutes and creates
// real resources; we run the full deploy in deploy-end-to-end-live.test.ts
// only.

describe("getAppEndpoint: missing app fast path", () => {
  it.skipIf(!RUN_LIVE)("returns exists=false for an app that does not exist", async () => {
    const result = await getAppEndpoint({
      appName: `kit-test-nonexistent-${Date.now()}`,
      profile: PROFILE!,
      timeoutMs: 30_000,
    });
    expect(result.exists).toBe(false);
    expect(result.url).toBeUndefined();
    expect(result.info).toBeUndefined();
  }, 60_000);

  it("documents the skip reason when CLI or profile is missing", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; live getAppEndpoint skipped.");
    } else if (!PROFILE) {
      console.log("LAKEBASE_TEST_PROFILE not set; live getAppEndpoint skipped.");
    }
    expect(true).toBe(true);
  });
});

describe("ensureAppEndpoint: infra-error contract", () => {
  it("rejects when CLI is missing entirely (synthetic infra failure path)", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    const dir = mkdtempSync(join(tmpdir(), "ensure-app-noclip-"));
    try {
      writeFileSync(join(dir, "app.yaml"), "command:\n  - true\n");
      // ensureAppEndpoint's first step is getAppEndpoint (apps get),
      // which uses exec(). With PATH stripped the exec rejects with
      // ENOENT and that propagates through ensureAppEndpoint.
      await expect(
        ensureAppEndpoint({
          workspaceRoot: dir,
          workspacePath: "/Workspace/Users/probe/any",
          profile: "any",
          appName: "any",
          deployTimeoutMs: 5_000,
        })
      ).rejects.toThrow(/failed to start|ENOENT|not found|spawn/i);
    } finally {
      process.env.PATH = origPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("getAppEndpoint: infra-error contract", () => {
  it.skipIf(!RUN_LIVE)("propagates non-missing CLI errors as a throw", async () => {
    // A non-existent profile should produce an auth error that is NOT
    // the missing-app pattern, so the function should throw rather
    // than return exists=false.
    await expect(
      getAppEndpoint({
        appName: "anything",
        profile: "definitely-not-a-real-profile-1234567890",
        timeoutMs: 15_000,
      })
    ).rejects.toThrow();
  }, 30_000);
});

describe("deleteAppEndpoint: idempotency on missing app", () => {
  it.skipIf(!RUN_LIVE)("returns found=false for an app that does not exist (default ignoreMissing)", async () => {
    const result = await deleteAppEndpoint({
      appName: `kit-test-nonexistent-${Date.now()}`,
      profile: PROFILE!,
      timeoutMs: 30_000,
    });
    expect(result.found).toBe(false);
    expect(result.appDeleted).toBe(false);
    expect(result.workspaceDeleted).toBe(false);
  }, 60_000);

  it.skipIf(!RUN_LIVE)("throws on missing app when ignoreMissing=false", async () => {
    await expect(
      deleteAppEndpoint({
        appName: `kit-test-nonexistent-${Date.now()}`,
        profile: PROFILE!,
        ignoreMissing: false,
        timeoutMs: 30_000,
      })
    ).rejects.toThrow();
  }, 60_000);
});

describe("deleteAppEndpoint: infra-error contract", () => {
  it("rejects when CLI is missing entirely", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        deleteAppEndpoint({
          appName: "any",
          profile: "any",
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/ENOENT|spawn|not found|failed to start/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);
});
