import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  projectPath,
  listBranches,
  getBranchByName,
  getDefaultBranch,
  resolveBranchPath,
  LakebaseBranchError,
} from "../../scripts/lakebase/branch-utils.js";

const cliAvailable = (() => {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

const TEST_INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const liveLookup = cliAvailable && !!TEST_INSTANCE;

describe("projectPath", () => {
  it("builds the canonical project resource path", () => {
    expect(projectPath("my-app")).toBe("projects/my-app");
  });
});

describe("LakebaseBranchError", () => {
  it("carries the right name", () => {
    const err = new LakebaseBranchError("oops");
    expect(err.name).toBe("LakebaseBranchError");
    expect(err.message).toBe("oops");
  });
});

describe("resolveBranchPath — short-circuit for full paths", () => {
  it("returns the input unchanged when it's already a full resource name", async () => {
    const full = "projects/my-app/branches/feature-x";
    const result = await resolveBranchPath(full, { instance: "my-app" });
    expect(result).toBe(full);
  });
});

describe.skipIf(!liveLookup)("branch-utils — live read against real Lakebase", () => {
  it("listBranches returns an array (possibly empty)", async () => {
    const branches = await listBranches({ instance: TEST_INSTANCE! });
    expect(Array.isArray(branches)).toBe(true);
  });

  it("getBranchByName returns undefined for a definitely-missing branch", async () => {
    const result = await getBranchByName("definitely-does-not-exist-zzz999", {
      instance: TEST_INSTANCE!,
    });
    expect(result).toBeUndefined();
  });

  it("getDefaultBranch returns either a branch or undefined (never throws)", async () => {
    const def = await getDefaultBranch({ instance: TEST_INSTANCE! });
    if (def !== undefined) {
      expect(def.isDefault).toBe(true);
      expect(def.name).toMatch(/^projects\//);
    }
  });
});

describe("branch-utils — skip-when-env-missing", () => {
  it("documents the skip reason when CLI or instance is missing", () => {
    if (liveLookup) return;
    // eslint-disable-next-line no-console
    console.log(
      cliAvailable
        ? "LAKEBASE_TEST_INSTANCE not set — live branch-utils suite skipped."
        : "`databricks` CLI not available — live branch-utils suite skipped."
    );
    expect(liveLookup).toBe(false);
  });
});
