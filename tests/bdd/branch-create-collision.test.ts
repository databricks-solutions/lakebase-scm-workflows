// Hermetic coverage for createBranch's collision-vs-idempotency contract.
//
// Live behavior is exercised by branch-create-delete.test.ts (which needs
// LAKEBASE_TEST_INSTANCE/PARENT and a real workspace). These cases run on
// every commit because they mock the substrate's CLI/lookup helpers — no
// Lakebase or git account needed.
//
// What we're guarding:
//   1. If the target name exists AND its source matches the requested
//      parent → return the existing branch (true idempotency on retry).
//   2. If the target name exists AND its source does NOT match → throw
//      LakebaseBranchError with a message naming both branches. Silently
//      handing back a branch with the wrong lineage is the failure mode
//      this test exists to prevent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LakebaseBranchError, type LakebaseBranchInfo } from "../../scripts/lakebase/branch-utils.js";

const mockGetBranchByName = vi.fn();
const mockGetDefaultBranch = vi.fn();

vi.mock("../../scripts/lakebase/branch-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/lakebase/branch-utils.js")>(
    "../../scripts/lakebase/branch-utils.js",
  );
  return {
    ...actual,
    getBranchByName: (...args: any[]) => mockGetBranchByName(...args),
    getDefaultBranch: (...args: any[]) => mockGetDefaultBranch(...args),
    projectPath: () => "projects/test-project",
  };
});

// Import after the mock is registered.
const { createBranch } = await import("../../scripts/lakebase/branch-create.js");

function fakeBranch(leaf: string, sourceLeaf: string | undefined): LakebaseBranchInfo {
  return {
    name: `projects/test-project/branches/${leaf}`,
    uid: `br-${leaf}`,
    state: "READY",
    isDefault: false,
    sourceBranchName: sourceLeaf
      ? `projects/test-project/branches/${sourceLeaf}`
      : undefined,
  } as LakebaseBranchInfo;
}

describe("createBranch — collision-vs-idempotency contract", () => {
  beforeEach(() => {
    mockGetBranchByName.mockReset();
    mockGetDefaultBranch.mockReset();
  });

  it("returns the existing branch when its source matches the requested parent (idempotent retry)", async () => {
    const existing = fakeBranch("feature-foo", "production");
    mockGetBranchByName.mockResolvedValue(existing);

    const result = await createBranch({
      instance: "ignored",
      branch: "feature-foo",
      parentBranch: "production",
    });

    expect(result).toBe(existing);
    // Lookup runs twice: once to resolve the parent path, once to check
    // for an existing target. Both are mocked; the real CLI is never
    // invoked, which is the whole point of the hermetic test.
  });

  it("throws when the existing branch was forked from a different source", async () => {
    // Existing branch was forked from staging…
    const existing = fakeBranch("feature-foo", "staging");
    mockGetBranchByName.mockResolvedValue(existing);

    // …but the caller is now asking to fork from production.
    await expect(
      createBranch({
        instance: "ignored",
        branch: "feature-foo",
        parentBranch: "production",
      }),
    ).rejects.toThrow(LakebaseBranchError);

    // Message names both the actual and requested sources so the operator
    // can see which choice the existing branch belongs to.
    await expect(
      createBranch({
        instance: "ignored",
        branch: "feature-foo",
        parentBranch: "production",
      }),
    ).rejects.toThrow(/forked from "staging".*requested "production"/);
  });

  it("returns existing when only the existing's sourceBranchName is unknown (can't compare ⇒ accept)", async () => {
    // Older branches created before the substrate started recording
    // spec.source_branch may report sourceBranchName as undefined.
    // Treat as "indeterminate, fall through to idempotent return"
    // rather than throwing — refusing the retry would surprise users
    // upgrading from older substrate revs.
    const existing = fakeBranch("feature-foo", undefined);
    mockGetBranchByName.mockResolvedValue(existing);

    const result = await createBranch({
      instance: "ignored",
      branch: "feature-foo",
      parentBranch: "production",
    });

    expect(result).toBe(existing);
  });
});
