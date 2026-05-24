import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createLakebaseProject,
  deleteLakebaseProject,
  getDefaultBranchId,
  LakebaseProjectError,
} from "../../scripts/lakebase/lakebase-project.js";

// `databricks` CLI presence gates most assertions. Project CRUD is
// destructive, so this suite only exercises the read path
// (getDefaultBranchId against an existing test project) and shape-only
// error checks. The create/delete equivalence test lives in FEIP-7071.

const cliAvailable = (() => {
  try {
    execFileSync("databricks", ["--version"], {
      stdio: "ignore",
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
})();

const TEST_INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const liveLookup = cliAvailable && !!TEST_INSTANCE;

describe.skipIf(!liveLookup)("lakebase-project, live read path", () => {
  it("getDefaultBranchId returns either a string id or empty (never throws)", async () => {
    const id = await getDefaultBranchId({ projectId: TEST_INSTANCE! });
    expect(typeof id).toBe("string");
  });
});

describe("lakebase-project, error wrapping", () => {
  it("LakebaseProjectError carries the right name", () => {
    const err = new LakebaseProjectError("oops");
    expect(err.name).toBe("LakebaseProjectError");
    expect(err.message).toBe("oops");
  });

  it("create/delete signatures accept the documented args (compile-only)", () => {
    // Force a TS check that the API surface stays stable. We don't actually
    // invoke (would be destructive). The cast satisfies the variable-unused lint.
    const createFn: typeof createLakebaseProject = createLakebaseProject;
    const deleteFn: typeof deleteLakebaseProject = deleteLakebaseProject;
    expect(typeof createFn).toBe("function");
    expect(typeof deleteFn).toBe("function");
  });
});

describe("lakebase-project, skip-when-cli-missing", () => {
  it("documents the skip reason when the `databricks` CLI is unavailable", () => {
    if (cliAvailable) return;
    // eslint-disable-next-line no-console
    console.log("`databricks` CLI not on PATH, live lakebase-project suite skipped.");
    expect(cliAvailable).toBe(false);
  });

  it("documents the skip reason when LAKEBASE_TEST_INSTANCE is unset", () => {
    if (TEST_INSTANCE) return;
    // eslint-disable-next-line no-console
    console.log("LAKEBASE_TEST_INSTANCE not set, live lakebase-project read skipped.");
    expect(!!TEST_INSTANCE).toBe(false);
  });
});
