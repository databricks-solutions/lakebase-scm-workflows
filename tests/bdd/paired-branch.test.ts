import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createPairedBranch,
  deletePairedBranch,
  syncEnvToCurrentBranch,
} from "../../scripts/lakebase/paired-branch.js";

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
const TEST_E2E = process.env.LAKEBASE_TEST_E2E === "1";
const live = cliAvailable && !!TEST_INSTANCE && !!TEST_PARENT && TEST_E2E;

describe("paired-branch — shape", () => {
  it("createPairedBranch signature accepts the documented args (compile-only)", () => {
    const fn: typeof createPairedBranch = createPairedBranch;
    expect(typeof fn).toBe("function");
  });

  it("deletePairedBranch signature accepts the documented args (compile-only)", () => {
    const fn: typeof deletePairedBranch = deletePairedBranch;
    expect(typeof fn).toBe("function");
  });

  it("syncEnvToCurrentBranch signature accepts the documented args (compile-only)", () => {
    const fn: typeof syncEnvToCurrentBranch = syncEnvToCurrentBranch;
    expect(typeof fn).toBe("function");
  });
});

describe.skipIf(!live)("paired-branch — destructive E2E", () => {
  it("create + delete a paired branch end-to-end (Lakebase only, --no-git)", async () => {
    // E2E here exercises the LAKEBASE side of the pairing without touching
    // an actual git repo (the function honors createGitBranch=false).
    const branch = `lbscm-paired-${Date.now()}`;
    const created = await createPairedBranch({
      instance: TEST_INSTANCE!,
      branch,
      parentBranch: TEST_PARENT!,
      cwd: process.cwd(),
      createGitBranch: false,
      syncEnv: false,
      readyTimeoutMs: 180_000,
    });
    expect(created.branch.state).toBe("READY");
    expect(created.gitBranch).toBeTruthy();

    const deleted = await deletePairedBranch({
      instance: TEST_INSTANCE!,
      branch: created.gitBranch,
      cwd: process.cwd(),
      deleteGitLocal: false,
      deleteGitRemote: false,
    });
    expect(deleted.lakebaseDeleted).toBe(true);
  }, 300_000);
});

describe("paired-branch — skip-when-env-missing", () => {
  it("documents the skip reason when destructive E2E is gated off", () => {
    if (live) return;
    // eslint-disable-next-line no-console
    console.log(
      !cliAvailable
        ? "`databricks` CLI not available — destructive paired-branch E2E skipped."
        : !TEST_E2E
          ? "LAKEBASE_TEST_E2E!=1 — destructive paired-branch E2E skipped."
          : "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_PARENT not set — destructive paired-branch E2E skipped."
    );
    expect(live).toBe(false);
  });
});
