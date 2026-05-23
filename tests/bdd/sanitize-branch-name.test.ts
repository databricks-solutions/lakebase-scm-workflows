import { describe, it, expect } from "vitest";
import { sanitizeBranchName } from "../../scripts/util/sanitize-branch-name.js";

describe("sanitizeBranchName", () => {
  it("flattens slashes to hyphens", () => {
    expect(sanitizeBranchName("feature/auth-rewrite")).toBe("feature-auth-rewrite");
  });

  it("lowercases", () => {
    expect(sanitizeBranchName("Feature/Auth")).toBe("feature-auth");
  });

  it("replaces non-alphanumeric (other than hyphen) with hyphens", () => {
    expect(sanitizeBranchName("feature/auth_v2.0!")).toBe("feature-auth-v2-0-");
  });

  it("truncates to 63 chars", () => {
    const long = "a".repeat(100);
    const result = sanitizeBranchName(long);
    expect(result.length).toBe(63);
  });

  it("pads to min 3 chars with -x", () => {
    expect(sanitizeBranchName("a")).toBe("a-x");
    expect(sanitizeBranchName("ab")).toBe("ab-x");
    expect(sanitizeBranchName("")).toBe("-x-x");
  });

  it("leaves 3+ char inputs alone (length-wise)", () => {
    expect(sanitizeBranchName("abc").length).toBeGreaterThanOrEqual(3);
  });
});
