import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compareExperiments } from "../../scripts/tdd/compare-experiments";

let tdd: string;

function seedExperiment(slug: string, outcomes: object): void {
  const dir = join(tdd, "experiments", "F1", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch.txt"), `feature/${slug}`);
  writeFileSync(join(dir, "outcomes.json"), JSON.stringify(outcomes));
}

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-compare-"));
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("compareExperiments", () => {
  it("recommends promote when exactly 1 experiment is winning and nothing else is running", () => {
    seedExperiment("exp-winner", { status: "succeeded", tests_passed: 5, tests_failed: 0 });
    const report = compareExperiments(tdd, "F1");
    expect(report.recommendation).toBe("promote");
    expect(report.rationale).toContain("exp-winner");
    expect(report.rows[0].signal).toBe("winning");
  });

  it("recommends synthesize when 2+ experiments are winning", () => {
    seedExperiment("exp-a", { status: "succeeded", tests_passed: 5 });
    seedExperiment("exp-b", { status: "succeeded", tests_passed: 5 });
    const report = compareExperiments(tdd, "F1");
    expect(report.recommendation).toBe("synthesize");
    expect(report.rows.filter((r) => r.signal === "winning").length).toBe(2);
  });

  it("recommends abandon-all when every experiment stalled", () => {
    seedExperiment("exp-a", { status: "failed" });
    seedExperiment("exp-b", { status: "failed" });
    const report = compareExperiments(tdd, "F1");
    expect(report.recommendation).toBe("abandon-all");
  });

  it("recommends continue when some experiments are still running", () => {
    seedExperiment("exp-a", { status: "running" });
    seedExperiment("exp-b", { status: "succeeded", tests_passed: 3 });
    const report = compareExperiments(tdd, "F1");
    expect(report.recommendation).toBe("continue");
  });

  it("returns an empty rows array for a feature with no experiments", () => {
    const report = compareExperiments(tdd, "F-none");
    expect(report.rows).toEqual([]);
    expect(report.recommendation).toBe("continue");
  });
});
