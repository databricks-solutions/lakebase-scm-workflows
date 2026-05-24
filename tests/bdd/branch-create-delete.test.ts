import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createBranch, waitForBranchReady } from "../../scripts/lakebase/branch-create.js";
import { deleteBranch } from "../../scripts/lakebase/branch-delete.js";
import { LakebaseBranchError } from "../../scripts/lakebase/branch-utils.js";

// createBranch / deleteBranch are destructive (real Lakebase API calls).
// Live tests gated on LAKEBASE_TEST_INSTANCE + LAKEBASE_TEST_PARENT
// (an existing branch to fork from). The test creates a uniquely-named
// branch, asserts READY, then deletes it. BDD equivalence vs the
// extension call site lives in FEIP-7065.

const cliAvailable = (() => {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

const TEST_INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const TEST_PARENT = process.env.LAKEBASE_TEST_PARENT;
const live = cliAvailable && !!TEST_INSTANCE && !!TEST_PARENT;

describe.skipIf(!live)("branch-create + delete, destructive live test", () => {
  it("creates a fresh Lakebase branch reaching READY, then deletes it", async () => {
    const branchName = `lbscm-test-${Date.now()}`;
    const created = await createBranch({
      instance: TEST_INSTANCE!,
      branch: branchName,
      parentBranch: TEST_PARENT,
      readyTimeoutMs: 180_000,
    });
    expect(created.state).toBe("READY");
    expect(created.uid).toBeTruthy();
    expect(created.name).toMatch(/^projects\/.*\/branches\//);

    await deleteBranch({ instance: TEST_INSTANCE!, branch: created.uid });
  }, 240_000);
});

describe("branch-create / delete, shape + error wrapping", () => {
  it("LakebaseBranchError carries the right name", () => {
    const err = new LakebaseBranchError("oops");
    expect(err.name).toBe("LakebaseBranchError");
  });

  it("waitForBranchReady signature accepts the documented args (compile-only)", () => {
    const fn: typeof waitForBranchReady = waitForBranchReady;
    expect(typeof fn).toBe("function");
  });
});

describe("branch-create / delete, skip-when-env-missing", () => {
  it("documents the skip reason when LAKEBASE_TEST_INSTANCE/PARENT or CLI missing", () => {
    if (live) return;
    // eslint-disable-next-line no-console
    console.log(
      !cliAvailable
        ? "`databricks` CLI not available, live branch-create/delete suite skipped."
        : "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_PARENT not set, live destructive suite skipped."
    );
    expect(live).toBe(false);
  });
});
