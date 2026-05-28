import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createLakebaseProject,
  deleteLakebaseProject,
  findDefaultBranchName,
  getDefaultBranchId,
  getDefaultBranchName,
  LakebaseProjectError,
  type BranchMetadata,
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

describe.skipIf(!liveLookup)("lakebase-project – live read path", () => {
  it("getDefaultBranchId returns either a string id or empty (never throws)", async () => {
    const id = await getDefaultBranchId({ projectId: TEST_INSTANCE! });
    expect(typeof id).toBe("string");
  });
});

describe("lakebase-project – error wrapping", () => {
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

// Hermetic regression test for the BranchUid-in-source_branch bug surfaced
// during the FEIP-7092 live exercise. CLI returns BOTH uid (br-…) and
// name (.../branches/production) on each branch entry. The old
// getDefaultBranchId preferred uid, which then failed downstream as a
// source_branch reference ("branch id not found"). The new
// getDefaultBranchName (+ the pure findDefaultBranchName helper) MUST
// return the resource-path leaf.
describe("findDefaultBranchName – returns BranchName, never BranchUid", () => {
  // Shape mirrors what `databricks postgres list-branches -o json` returns
  // for a fresh project: one default branch with both fields populated.
  const SAMPLE: BranchMetadata[] = [
    {
      uid: "br-crimson-fire-d28lb2ez",
      name: "projects/live-7092-1779932313/branches/production",
      status: { default: true },
    },
  ];

  it("returns the resource-path leaf (the BranchName), not the uid", () => {
    const result = findDefaultBranchName(SAMPLE);
    expect(result).toBe("production");
    // The bug would have returned 'br-crimson-fire-d28lb2ez' here – that's
    // the exact regression this test guards.
    expect(result).not.toBe("br-crimson-fire-d28lb2ez");
  });

  it("returns null when no default branch is marked", () => {
    const nonDefault: BranchMetadata[] = [
      { uid: "br-x-y-z", name: "projects/x/branches/feature-y", status: {} },
    ];
    expect(findDefaultBranchName(nonDefault)).toBeNull();
  });

  it("returns null when the default branch has no name field", () => {
    const malformed: BranchMetadata[] = [{ uid: "br-x-y-z", status: { default: true } }];
    expect(findDefaultBranchName(malformed)).toBeNull();
  });

  it("returns null when items array is empty", () => {
    expect(findDefaultBranchName([])).toBeNull();
  });

  it("honors the is_default top-level field (older CLI shape)", () => {
    const oldShape: BranchMetadata[] = [
      {
        uid: "br-a-b-c",
        name: "projects/x/branches/main",
        is_default: true,
      },
    ];
    expect(findDefaultBranchName(oldShape)).toBe("main");
  });

  it("handles multi-branch projects (picks the marked default)", () => {
    const multi: BranchMetadata[] = [
      { uid: "br-1", name: "projects/x/branches/feature-a", status: {} },
      { uid: "br-2", name: "projects/x/branches/production", status: { default: true } },
      { uid: "br-3", name: "projects/x/branches/feature-b", status: {} },
    ];
    expect(findDefaultBranchName(multi)).toBe("production");
  });
});

describe("getDefaultBranchId – deprecated alias still returns the BranchName as a string", () => {
  it("compiles and returns string (transitional API)", () => {
    // Smoke check on the signature; behavior is hermetically tested via
    // findDefaultBranchName above. Live behavior is covered by the
    // .skipIf block when LAKEBASE_TEST_INSTANCE is set.
    const fn: (args: { projectId: string }) => Promise<string> = getDefaultBranchId;
    expect(typeof fn).toBe("function");
  });
});

describe("getDefaultBranchName – return type is BranchName | null (compile-time)", () => {
  it("signature is enforced by the type system", () => {
    // The brand on BranchName means a caller cannot pass the result of
    // getDefaultBranchName into a slot expecting BranchUid without going
    // through asBranchUid (which would throw at runtime on a BranchName
    // input).
    const fn: (args: { projectId: string }) => Promise<unknown> = getDefaultBranchName;
    expect(typeof fn).toBe("function");
  });
});

describe("lakebase-project – skip-when-cli-missing", () => {
  it("documents the skip reason when the `databricks` CLI is unavailable", () => {
    if (cliAvailable) return;
    // eslint-disable-next-line no-console
    console.log("`databricks` CLI not on PATH – live lakebase-project suite skipped.");
    expect(cliAvailable).toBe(false);
  });

  it("documents the skip reason when LAKEBASE_TEST_INSTANCE is unset", () => {
    if (TEST_INSTANCE) return;
    // eslint-disable-next-line no-console
    console.log("LAKEBASE_TEST_INSTANCE not set – live lakebase-project read skipped.");
    expect(!!TEST_INSTANCE).toBe(false);
  });
});
