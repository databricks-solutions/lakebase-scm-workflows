import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./harness.js";

// Smoke test for the BDD harness scaffold. As real ops land, additional
// *.test.ts files (create-project-equivalence.test.ts, etc.) replace this
// file as the source of truth. This file exists to prove the harness
// compiles and Vitest is wired correctly on a fresh install.

describe("bdd harness scaffold", () => {
  it("loads without throwing", () => {
    expect(typeof assertEquivalent).toBe("function");
  });

  it("assertEquivalent throws when ops mismatch", () => {
    expect(() =>
      assertEquivalent(
        {
          op: "foo",
          stdout: "",
          exitCode: 0,
          filesTouched: [],
          gitState: {},
          lakebaseState: {},
        },
        {
          op: "bar",
          stdout: "",
          exitCode: 0,
          filesTouched: [],
          gitState: {},
          lakebaseState: {},
        }
      )
    ).toThrow(/Op mismatch/);
  });

  it("assertEquivalent passes when results are identical", () => {
    const result = {
      op: "noop",
      stdout: "",
      exitCode: 0,
      filesTouched: [] as string[],
      gitState: {} as Record<string, string>,
      lakebaseState: {} as Record<string, string>,
    };
    expect(() => assertEquivalent(result, result)).not.toThrow();
  });
});
