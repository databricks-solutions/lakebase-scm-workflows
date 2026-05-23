import { describe, it, expect } from "vitest";
import { parseOwnerRepo, formatOwnerRepo } from "../../scripts/util/parse-owner-repo.js";

describe("parseOwnerRepo", () => {
  it("parses 'owner/repo' slugs", () => {
    expect(parseOwnerRepo("databricks-solutions/lakebase-scm-extension")).toEqual({
      owner: "databricks-solutions",
      repo: "lakebase-scm-extension",
    });
  });

  it("parses HTTPS GitHub URLs", () => {
    expect(parseOwnerRepo("https://github.com/databricks-solutions/lakebase-scm-extension")).toEqual({
      owner: "databricks-solutions",
      repo: "lakebase-scm-extension",
    });
  });

  it("parses HTTPS URLs ending in .git", () => {
    expect(parseOwnerRepo("https://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
  });

  it("parses git SSH URLs (git@github.com:owner/repo)", () => {
    expect(parseOwnerRepo("git@github.com:foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
  });

  it("throws on a bare repo name (no slash)", () => {
    expect(() => parseOwnerRepo("just-a-name")).toThrow(/Invalid GitHub repo reference/);
  });
});

describe("formatOwnerRepo", () => {
  it("joins owner and repo with a slash", () => {
    expect(formatOwnerRepo("foo", "bar")).toBe("foo/bar");
  });
});
