// Hermetic coverage for the convention-branches helpers.
//
// Verifies that createFeatureBranch / createTestBranch / createUatBranch /
// createPerfBranch forward the right parent + TTL into substrate's
// createBranch — without actually hitting Lakebase. Live behavior is
// exercised in the workspace-bound branch tests; this test is the contract
// guard.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateBranch = vi.fn();

vi.mock("../../scripts/lakebase/branch-create.js", () => ({
  createBranch: (...args: unknown[]) => mockCreateBranch(...args),
}));

// Import after the mock is registered.
const conv = await import("../../scripts/lakebase/convention-branches.js");

beforeEach(() => {
  mockCreateBranch.mockReset();
  mockCreateBranch.mockResolvedValue({
    name: "projects/p/branches/x",
    uid: "br-x",
    state: "READY",
    isDefault: false,
  });
});

describe("convention-branches: default tier values", () => {
  it("createFeatureBranch defaults parentBranch=staging, ttl=30 days", async () => {
    await conv.createFeatureBranch({ instance: "p", branch: "f1" });
    expect(mockCreateBranch).toHaveBeenCalledTimes(1);
    expect(mockCreateBranch.mock.calls[0][0]).toMatchObject({
      instance: "p",
      branch: "f1",
      parentBranch: "staging",
      ttl: `${30 * 86_400}s`,
    });
  });

  it("createTestBranch defaults parentBranch=staging, ttl=14 days", async () => {
    await conv.createTestBranch({ instance: "p", branch: "t1" });
    expect(mockCreateBranch.mock.calls[0][0]).toMatchObject({
      parentBranch: "staging",
      ttl: `${14 * 86_400}s`,
    });
  });

  it("createUatBranch defaults parentBranch=staging, ttl=14 days", async () => {
    await conv.createUatBranch({ instance: "p", branch: "u1" });
    expect(mockCreateBranch.mock.calls[0][0]).toMatchObject({
      parentBranch: "staging",
      ttl: `${14 * 86_400}s`,
    });
  });

  it("createPerfBranch defaults parentBranch=staging, ttl=7 days", async () => {
    await conv.createPerfBranch({ instance: "p", branch: "perf1" });
    expect(mockCreateBranch.mock.calls[0][0]).toMatchObject({
      parentBranch: "staging",
      ttl: `${7 * 86_400}s`,
    });
  });
});

describe("convention-branches: caller overrides", () => {
  it("ttl override is forwarded as-is", async () => {
    await conv.createFeatureBranch({ instance: "p", branch: "f2", ttl: "3600s" });
    expect(mockCreateBranch.mock.calls[0][0].ttl).toBe("3600s");
  });

  it("parentBranch override is forwarded", async () => {
    await conv.createTestBranch({
      instance: "p",
      branch: "t2",
      parentBranch: "dev",
    });
    expect(mockCreateBranch.mock.calls[0][0].parentBranch).toBe("dev");
  });

  it("host is forwarded", async () => {
    await conv.createUatBranch({ instance: "p", branch: "u2", host: "https://h" });
    expect(mockCreateBranch.mock.calls[0][0].host).toBe("https://h");
  });
});

describe("CONVENTION_TIER_DEFAULTS exposes tier metadata", () => {
  it("declares all four tiers with parentBranch + ttl", () => {
    for (const tier of ["feature", "test", "uat", "perf"] as const) {
      const d = conv.CONVENTION_TIER_DEFAULTS[tier];
      expect(d.parentBranch).toBe("staging");
      expect(d.ttl).toMatch(/^\d+s$/);
    }
  });
});
