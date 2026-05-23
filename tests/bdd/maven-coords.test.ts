import { describe, it, expect } from "vitest";
import { sanitizeArtifactId } from "../../scripts/util/maven-coords.js";

describe("sanitizeArtifactId", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(sanitizeArtifactId("My Cool App")).toBe("my-cool-app");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeArtifactId("foo!!!bar")).toBe("foo-bar");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeArtifactId("-foo-")).toBe("foo");
  });

  it("defaults to 'demo' for empty input", () => {
    expect(sanitizeArtifactId("")).toBe("demo");
    expect(sanitizeArtifactId("---")).toBe("demo");
  });

  it("prefixes 'app-' when the result starts with a digit", () => {
    expect(sanitizeArtifactId("123-test")).toBe("app-123-test");
  });
});
