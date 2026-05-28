import { describe, it, expect } from "vitest";
import {
  asBranchName,
  asBranchUid,
  branchNameFromResourcePath,
  looksLikeBranchUid,
  type BranchName,
  type BranchUid,
} from "../../scripts/lakebase/branch-id";

describe("looksLikeBranchUid", () => {
  it("recognizes the br-… pattern", () => {
    expect(looksLikeBranchUid("br-crimson-fire-d28lb2ez")).toBe(true);
    expect(looksLikeBranchUid("br-broad-sky-d2k5gewt")).toBe(true);
    expect(looksLikeBranchUid("br-a-b-c")).toBe(true);
  });

  it("rejects path-leaf branch names (no br- prefix)", () => {
    expect(looksLikeBranchUid("production")).toBe(false);
    expect(looksLikeBranchUid("staging")).toBe(false);
    expect(looksLikeBranchUid("feature-add-orders")).toBe(false);
    expect(looksLikeBranchUid("main")).toBe(false);
  });

  it("rejects strings that happen to contain 'br-' mid-name", () => {
    expect(looksLikeBranchUid("feature-br-something")).toBe(false);
    expect(looksLikeBranchUid("Branch-x-y-z")).toBe(false);
  });
});

describe("asBranchName", () => {
  it("accepts plain resource-path leaves", () => {
    expect(asBranchName("production")).toBe("production");
    expect(asBranchName("staging")).toBe("staging");
    expect(asBranchName("feature-add-orders")).toBe("feature-add-orders");
  });

  it("THROWS when given a BranchUid (this is the bug-prevention contract)", () => {
    expect(() => asBranchName("br-crimson-fire-d28lb2ez")).toThrow(/looks like a BranchUid/);
    expect(() => asBranchName("br-broad-sky-d2k5gewt")).toThrow(/BranchUid/);
  });

  it("THROWS on empty input", () => {
    expect(() => asBranchName("")).toThrow(/cannot be empty/);
  });

  it("error message points the caller to the right function + explains the path-leaf concept", () => {
    let msg = "";
    try {
      asBranchName("br-x-y-z");
    } catch (e) {
      msg = (e as Error).message;
    }
    // The thrower is asBranchName; the helpful suggestion is "did you
    // mean asBranchUid?" so the caller can pivot.
    expect(msg).toMatch(/asBranchUid/);
    expect(msg).toMatch(/path[\s-]?shaped|resource[\s-]?path/i);
    expect(msg).toMatch(/BranchUid/);
    expect(msg).toMatch(/BranchName/);
  });
});

describe("asBranchUid", () => {
  it("accepts the br-… form", () => {
    expect(asBranchUid("br-crimson-fire-d28lb2ez")).toBe("br-crimson-fire-d28lb2ez");
  });

  it("THROWS when given a BranchName (the inverse contract)", () => {
    expect(() => asBranchUid("production")).toThrow(/not a BranchUid/);
    expect(() => asBranchUid("feature-x")).toThrow(/not a BranchUid/);
  });

  it("THROWS on empty input", () => {
    expect(() => asBranchUid("")).toThrow(/cannot be empty/);
  });
});

describe("branchNameFromResourcePath", () => {
  it("extracts the leaf from a full path", () => {
    expect(branchNameFromResourcePath("projects/proj-abc/branches/production")).toBe("production");
    expect(branchNameFromResourcePath("projects/x/branches/feature-add-orders")).toBe("feature-add-orders");
  });

  it("returns null when input is not a resource path", () => {
    expect(branchNameFromResourcePath("production")).toBeNull();
    expect(branchNameFromResourcePath("projects/x")).toBeNull();
    expect(branchNameFromResourcePath("")).toBeNull();
  });

  it("returns null when the leaf would itself be a BranchUid (refuses to lie about which kind of id this is)", () => {
    expect(branchNameFromResourcePath("projects/x/branches/br-crimson-fire-d28lb2ez")).toBeNull();
  });
});

// Type-level contracts. These assertions don't add runtime checks but
// ensure the brand prevents accidental cross-assignment at compile time.
// (If someone removes the brand, the @ts-expect-error lines will start
// passing and the test file will fail to compile, surfacing the regression.)
describe("type-level brand contracts", () => {
  it("BranchName and BranchUid cannot be swapped at the type level", () => {
    const name: BranchName = asBranchName("production");
    const uid: BranchUid = asBranchUid("br-x-y-z");

    // Allow assignment to the broader `string` type – brands are downcast-able.
    const _s1: string = name;
    const _s2: string = uid;
    expect(_s1).toBe("production");
    expect(_s2).toBe("br-x-y-z");

    // @ts-expect-error – BranchName is not assignable to BranchUid.
    const _bad1: BranchUid = name;
    void _bad1;
    // @ts-expect-error – BranchUid is not assignable to BranchName.
    const _bad2: BranchName = uid;
    void _bad2;
    // @ts-expect-error – plain string is not assignable to BranchName.
    const _bad3: BranchName = "production";
    void _bad3;
    // @ts-expect-error – plain string is not assignable to BranchUid.
    const _bad4: BranchUid = "br-x-y-z";
    void _bad4;
  });
});
