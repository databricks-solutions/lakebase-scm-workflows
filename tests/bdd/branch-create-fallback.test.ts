// Hermetic coverage for createBranch's parentBranch-existence fallback.
//
// Surfaced during the FEIP-7092 live exercise: CONVENTION_TIER_DEFAULTS
// declares parentBranch="staging" for the four short-tier flavors, but
// bare-provisioned Lakebase projects ship with only `production` — no
// `staging`. The substrate previously interpolated the named parent into
// the source_branch path and let the API return the opaque
// "branch id not found" error. Now: when the named parent doesn't exist,
// substrate falls back to the project default branch with a stderr
// warning. Opt-OUT via `strictParent: true`.
//
// Test mechanics mirror branch-create-collision.test.ts: mock the lookup
// helpers from branch-utils so createBranch is exercised end-to-end
// without invoking the Databricks CLI. Tests that take the success path
// have the target lookup return an EXISTING branch whose source matches
// the resolved parent — createBranch then short-circuits via its
// idempotency check (line ~128 of branch-create.ts), so dbcli is never
// reached.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LakebaseBranchError,
  type LakebaseBranchInfo,
} from "../../scripts/lakebase/branch-utils.js";

const mockGetBranchByName = vi.fn();
const mockGetDefaultBranch = vi.fn();

vi.mock("../../scripts/lakebase/branch-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../scripts/lakebase/branch-utils.js")>(
      "../../scripts/lakebase/branch-utils.js"
    );
  return {
    ...actual,
    getBranchByName: (...args: unknown[]) => mockGetBranchByName(...args),
    getDefaultBranch: (...args: unknown[]) => mockGetDefaultBranch(...args),
    projectPath: () => "projects/test-project",
  };
});

const { createBranch } = await import("../../scripts/lakebase/branch-create.js");

function fakeBranch(leaf: string, sourceLeaf: string | undefined): LakebaseBranchInfo {
  return {
    name: `projects/test-project/branches/${leaf}`,
    nameLeaf: leaf as LakebaseBranchInfo["nameLeaf"],
    uid: `br-${leaf}` as LakebaseBranchInfo["uid"],
    state: "READY",
    isDefault: false,
    sourceBranchName: sourceLeaf
      ? `projects/test-project/branches/${sourceLeaf}`
      : undefined,
  } as LakebaseBranchInfo;
}

let stderrChunks: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any;

beforeEach(() => {
  mockGetBranchByName.mockReset();
  mockGetDefaultBranch.mockReset();
  stderrChunks = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("createBranch – parentBranch fallback when the named parent is missing", () => {
  it("falls back to the project default + emits a stderr warning (default behavior)", async () => {
    // Parent lookup: 'staging' doesn't exist.
    // Target lookup: 'feature-x' already exists, forked from 'production'
    //   (the project default) — short-circuits via idempotency, no CLI call.
    mockGetBranchByName.mockImplementation((branchName: string) => {
      if (branchName === "staging") return Promise.resolve(undefined);
      if (branchName === "feature-x") return Promise.resolve(fakeBranch("feature-x", "production"));
      return Promise.resolve(undefined);
    });
    mockGetDefaultBranch.mockResolvedValue(fakeBranch("production", undefined));

    const result = await createBranch({
      instance: "test-project",
      branch: "feature-x",
      parentBranch: "staging",
      // strictParent omitted → default fallback behavior
    });

    // The fallback fired — stderr has the documented warning.
    const stderr = stderrChunks.join("");
    expect(stderr).toMatch(/parentBranch 'staging' not found/);
    expect(stderr).toMatch(/falling back to default branch 'production'/);
    expect(stderr).toMatch(/strictParent: true/);

    // Idempotency short-circuit returned the existing branch — proves the
    // resolved source ('production') matched what the target was forked from.
    expect(result.name).toBe("projects/test-project/branches/feature-x");
    expect(result.sourceBranchName).toBe("projects/test-project/branches/production");
  });

  it("uses the named parent directly when it exists (no fallback, no warning)", async () => {
    mockGetBranchByName.mockImplementation((branchName: string) => {
      if (branchName === "staging") return Promise.resolve(fakeBranch("staging", "production"));
      if (branchName === "feature-x") return Promise.resolve(fakeBranch("feature-x", "staging"));
      return Promise.resolve(undefined);
    });

    const result = await createBranch({
      instance: "test-project",
      branch: "feature-x",
      parentBranch: "staging",
    });

    // No fallback warning emitted on the happy path.
    expect(stderrChunks.join("")).toBe("");
    // Idempotency short-circuit returned the existing branch with the
    // expected lineage ('staging' → 'feature-x').
    expect(result.sourceBranchName).toBe("projects/test-project/branches/staging");
    // getDefaultBranch was not consulted on the happy path.
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
  });

  it("throws with a typed error when strictParent: true + parent missing", async () => {
    mockGetBranchByName.mockResolvedValue(undefined);

    await expect(
      createBranch({
        instance: "test-project",
        branch: "feature-x",
        parentBranch: "staging",
        strictParent: true,
      })
    ).rejects.toThrow(LakebaseBranchError);

    await expect(
      createBranch({
        instance: "test-project",
        branch: "feature-x",
        parentBranch: "staging",
        strictParent: true,
      })
    ).rejects.toThrow(/parentBranch 'staging' does not exist.*strictParent: true was set/s);

    // No fallback warning emitted in strict mode.
    expect(stderrChunks.join("")).toBe("");
    // getDefaultBranch was NOT consulted — strict mode refuses at the
    // boundary before reaching the fallback path.
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
  });

  it("throws when parent missing AND project has no default branch to fall back to", async () => {
    mockGetBranchByName.mockResolvedValue(undefined);
    mockGetDefaultBranch.mockResolvedValue(undefined);

    await expect(
      createBranch({
        instance: "test-project",
        branch: "feature-x",
        parentBranch: "staging",
        // strictParent omitted — fallback is enabled, but nothing to fall back to
      })
    ).rejects.toThrow(/has no default branch to fall back to/);
  });
});
