import { describe, it, expect } from "vitest";
import {
  LakebaseBranchError,
  LakebaseBranchTtlTooLongError,
  isTtlTooLongError,
} from "../../scripts/lakebase/branch-utils";

// Workspace-TTL-policy substrate surface. Surfaced during the FEIP-7092
// live E2E: the CONVENTION_TIER_DEFAULTS.feature 30-day TTL exceeded the
// test workspace's maximum-expiration policy. The substrate detects the
// underlying CLI error and rewraps with a typed, actionable message so
// callers get a clear remediation path (shorter ttl OR noExpiry).

describe("isTtlTooLongError – detects the workspace cap rejection", () => {
  const REAL_STDERR =
    "databricks postgres create-branch projects/x foo --json {} failed: Command failed: " +
    "databricks postgres create-branch projects/x foo --json {}\n" +
    "Error: expiration time exceeds the maximum expiration time [TraceId: abc123]\n" +
    "stderr: Error: expiration time exceeds the maximum expiration time [TraceId: abc123]";

  it("matches the live error message verbatim", () => {
    expect(isTtlTooLongError(REAL_STDERR)).toBe(true);
  });

  it("matches case-insensitively (defensive against minor server reword)", () => {
    expect(isTtlTooLongError("EXPIRATION TIME EXCEEDS THE MAXIMUM EXPIRATION TIME")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTtlTooLongError("branch id not found")).toBe(false);
    expect(isTtlTooLongError("permission denied")).toBe(false);
    expect(isTtlTooLongError("expiration is required")).toBe(false);
    expect(isTtlTooLongError("")).toBe(false);
  });
});

describe("LakebaseBranchTtlTooLongError – typed error contract", () => {
  it("extends LakebaseBranchError so existing catch blocks still trigger", () => {
    const err = new LakebaseBranchTtlTooLongError("2592000s", "underlying CLI error");
    expect(err).toBeInstanceOf(LakebaseBranchError);
    expect(err).toBeInstanceOf(LakebaseBranchTtlTooLongError);
    expect(err.name).toBe("LakebaseBranchTtlTooLongError");
  });

  it("exposes the attempted TTL so callers can build a remediation", () => {
    const err = new LakebaseBranchTtlTooLongError("2592000s", "cli barfed");
    expect(err.attemptedTtl).toBe("2592000s");
  });

  it("message names the override paths the caller can take (ttl arg, noExpiry)", () => {
    const err = new LakebaseBranchTtlTooLongError("2592000s", "x");
    expect(err.message).toMatch(/2592000s/);
    expect(err.message).toMatch(/shorter ttl/i);
    expect(err.message).toMatch(/noExpiry/);
    expect(err.message).toMatch(/history_retention_duration/);
  });

  it("includes the underlying error so the trace isn't lost", () => {
    const err = new LakebaseBranchTtlTooLongError(
      "2592000s",
      "Error: expiration time exceeds the maximum expiration time [TraceId: t1]"
    );
    expect(err.message).toMatch(/TraceId: t1/);
  });
});
