// FEIP-7145: branch identifier normalization + parent-branch adapter.
//
// Two layers of coverage:
//
//   1. Pure unit tests for resolveBranchId's input-shape detection
//      (fast path / full-path strip / uid prefix). No CLI required.
//   2. Live BDD pair-coverage: any public substrate helper that takes a
//      `branch` parameter and ultimately builds a CLI subresource URL must
//      return identical results when called with branch_id, branch_uid, or
//      full resource path. Gated on LAKEBASE_TEST_INSTANCE + a branch.
//
// The parent-branch adapter fix is verified live via getBranchByName:
// `status.source_branch` must surface as `sourceBranchName` /
// `sourceBranchId` on the adapter output for any non-default branch.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  getBranchByName,
  listBranches,
  resolveBranchId,
  LakebaseBranchError,
} from "../../scripts/lakebase/branch-utils.js";
import { getEndpoint, endpointPath } from "../../scripts/lakebase/branch-endpoint.js";
import { queryBranchSchema } from "../../scripts/lakebase/branch-schema.js";
import { resolveEndpointHost } from "../../scripts/lakebase/get-connection.js";

const cliAvailable = (() => {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

const TEST_INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const TEST_BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const live = cliAvailable && !!TEST_INSTANCE && !!TEST_BRANCH;

describe("resolveBranchId – input-shape fast paths (no CLI)", () => {
  it("returns the input unchanged when it is already a branch_id", async () => {
    // No CLI hit because there's no `br-` prefix and no `projects/...` path.
    const out = await resolveBranchId({ instance: "fake", branch: "demo-feature" });
    expect(out).toBe("demo-feature");
  });

  it("returns the tier name unchanged (tier === branch_id)", async () => {
    for (const tier of ["production", "staging", "uat", "perf"]) {
      const out = await resolveBranchId({ instance: "fake", branch: tier });
      expect(out).toBe(tier);
    }
  });

  it("strips the full resource path to the leaf id", async () => {
    const out = await resolveBranchId({
      instance: "fake",
      branch: "projects/some-app/branches/feature-x",
    });
    expect(out).toBe("feature-x");
  });

  it("strips the path even when the embedded project differs from args.instance", async () => {
    // The function trusts the path leaf; mismatched project is the caller's
    // problem (and the CLI will surface it downstream).
    const out = await resolveBranchId({
      instance: "different",
      branch: "projects/embedded-project/branches/whatever",
    });
    expect(out).toBe("whatever");
  });

  it("throws LakebaseBranchError when a uid resolves to nothing (slow path)", async () => {
    // Skipping when no CLI – the slow path requires a list-branches call.
    if (!live) return;
    await expect(
      resolveBranchId({ instance: TEST_INSTANCE!, branch: "br-does-not-exist-xyz" })
    ).rejects.toBeInstanceOf(LakebaseBranchError);
  });
});

describe("parseBranch – parent-branch adapter (live)", () => {
  it.skipIf(!live)(
    "sourceBranchName + sourceBranchId are populated from status.source_branch",
    async () => {
      // The test branch is expected to be a forked branch (not the default),
      // so its Lakebase metadata MUST expose a parent under status.source_branch.
      // If your LAKEBASE_TEST_BRANCH is the default branch, this is expected
      // to expose neither field; allow either shape.
      const info = await getBranchByName(TEST_BRANCH!, { instance: TEST_INSTANCE! });
      expect(info).toBeTruthy();
      if (info!.isDefault) {
        expect(info!.sourceBranchName).toBeUndefined();
        expect(info!.sourceBranchId).toBeUndefined();
        return;
      }
      expect(info!.sourceBranchName).toMatch(/^projects\/.+\/branches\/.+$/);
      expect(info!.sourceBranchId).toBeTruthy();
      expect(info!.sourceBranchId).toBe(info!.sourceBranchName!.split("/branches/").pop());
    }
  );
});

describe("branch identifier pair-coverage – live", () => {
  it.skipIf(!live)("getEndpoint(uid) === getEndpoint(branchId)", async () => {
    const info = await getBranchByName(TEST_BRANCH!, { instance: TEST_INSTANCE! });
    expect(info).toBeTruthy();
    const epByName = await getEndpoint({ instance: TEST_INSTANCE!, branch: TEST_BRANCH! });
    const epByUid = await getEndpoint({ instance: TEST_INSTANCE!, branch: info!.uid });
    expect(epByUid).toEqual(epByName);
  });

  it.skipIf(!live)("resolveEndpointHost(uid) === resolveEndpointHost(branchId)", async () => {
    const info = await getBranchByName(TEST_BRANCH!, { instance: TEST_INSTANCE! });
    expect(info).toBeTruthy();
    const hostByName = await resolveEndpointHost(TEST_INSTANCE!, TEST_BRANCH!);
    const hostByUid = await resolveEndpointHost(TEST_INSTANCE!, info!.uid);
    expect(hostByUid).toBe(hostByName);
  });

  it.skipIf(!live)("queryBranchSchema(uid) === queryBranchSchema(branchId)", async () => {
    const info = await getBranchByName(TEST_BRANCH!, { instance: TEST_INSTANCE! });
    expect(info).toBeTruthy();
    const byName = await queryBranchSchema({ instance: TEST_INSTANCE!, branch: TEST_BRANCH! });
    const byUid = await queryBranchSchema({ instance: TEST_INSTANCE!, branch: info!.uid });
    expect(byUid).toEqual(byName);
  });

  it.skipIf(!live)("endpointPath stays sync and does NOT accept a uid", async () => {
    // Sanity check: endpointPath is documented as sync + branch_id-only. We
    // don't want anyone "fixing" it to silently accept a uid via an async
    // resolution. If you intentionally change that, update both the JSDoc
    // and this test together.
    const info = await getBranchByName(TEST_BRANCH!, { instance: TEST_INSTANCE! });
    expect(info).toBeTruthy();
    const path = endpointPath(TEST_INSTANCE!, info!.uid);
    expect(path).toBe(`projects/${TEST_INSTANCE}/branches/${info!.uid}/endpoints/primary`);
    expect(path).toContain(info!.uid); // Verbatim. No normalization.
  });

  it.skipIf(!live)("listBranches surfaces sourceBranchName for non-default branches", async () => {
    const branches = await listBranches({ instance: TEST_INSTANCE! });
    const nonDefault = branches.filter((b) => !b.isDefault);
    // At least one non-default branch should have a parent recorded —
    // otherwise the adapter has nothing to assert against.
    const withParent = nonDefault.filter((b) => b.sourceBranchName);
    expect(withParent.length).toBeGreaterThan(0);
    for (const b of withParent) {
      expect(b.sourceBranchName).toMatch(/^projects\/.+\/branches\/.+$/);
      expect(b.sourceBranchId).toBe(b.sourceBranchName!.split("/branches/").pop());
    }
  });
});
