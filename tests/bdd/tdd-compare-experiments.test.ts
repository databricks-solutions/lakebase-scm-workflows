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

// Structured-payload tests (FEIP-7092 slice 4): downstream comparison-report
// renderer (FEIP-7208) consumes per-tag matrix, cycle counts, artifact counts.

import { writeArtifact } from "../../scripts/tdd/artifacts";

function seedExperimentRich(
  slug: string,
  outcomes: object,
  opts: { cycles?: number; artifacts?: string[]; durationMs?: number } = {}
): void {
  const dir = join(tdd, "experiments", "F1", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch.txt"), `feature/${slug}`);
  writeFileSync(join(dir, "outcomes.json"), JSON.stringify(outcomes));
  if (opts.cycles) {
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify({
        entries: Array.from({ length: opts.cycles }, (_, i) => ({
          ts: `2026-05-27T10:0${i}:00Z`,
          kind: i === 0 ? "cut" : "cycle",
        })),
      })
    );
  }
  if (opts.artifacts) {
    for (const name of opts.artifacts) {
      writeArtifact({
        tddDir: tdd,
        featureId: "F1",
        experimentSlug: slug,
        cycleId: "C1",
        name,
        content: "x",
      });
    }
  }
  if (opts.durationMs !== undefined) {
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ duration_ms: opts.durationMs }));
  }
}

describe("compareExperiments structured payload (FEIP-7092 slice 4)", () => {
  it("each row carries cycle_count from timeline.json (0 when timeline missing)", () => {
    seedExperimentRich("exp-with-cycles", { status: "running", tests_passed: 1 }, { cycles: 4 });
    seedExperimentRich("exp-no-timeline", { status: "running", tests_passed: 0 });
    const report = compareExperiments(tdd, "F1");
    const bySlug = Object.fromEntries(report.rows.map((r) => [r.experiment_slug, r]));
    expect(bySlug["exp-with-cycles"].cycle_count).toBe(4);
    expect(bySlug["exp-no-timeline"].cycle_count).toBe(0);
  });

  it("each row carries artifact_count from listArtifacts (0 when none written)", () => {
    seedExperimentRich(
      "exp-with-artifacts",
      { status: "running" },
      { artifacts: ["vitest.junit.xml", "trace.zip"] }
    );
    seedExperimentRich("exp-no-artifacts", { status: "running" });
    const report = compareExperiments(tdd, "F1");
    const bySlug = Object.fromEntries(report.rows.map((r) => [r.experiment_slug, r]));
    expect(bySlug["exp-with-artifacts"].artifact_count).toBe(2);
    expect(bySlug["exp-no-artifacts"].artifact_count).toBe(0);
  });

  it("each row carries duration_ms when runtime.json is written", () => {
    seedExperimentRich("exp-timed", { status: "succeeded", tests_passed: 1 }, { durationMs: 12345 });
    seedExperimentRich("exp-untimed", { status: "running" });
    const report = compareExperiments(tdd, "F1");
    const bySlug = Object.fromEntries(report.rows.map((r) => [r.experiment_slug, r]));
    expect(bySlug["exp-timed"].duration_ms).toBe(12345);
    expect(bySlug["exp-untimed"].duration_ms).toBeUndefined();
  });

  it("rows include by_tag when the experiment reported a tag breakdown", () => {
    seedExperimentRich("exp-tagged", {
      status: "running",
      tests_passed: 4,
      tests_failed: 1,
      by_tag: {
        api: { passed: 3, failed: 0 },
        e2e: { passed: 1, failed: 1 },
      },
    });
    const report = compareExperiments(tdd, "F1");
    expect(report.rows[0].by_tag).toEqual({
      api: { passed: 3, failed: 0 },
      e2e: { passed: 1, failed: 1 },
    });
  });

  it("matrix has one row per tag any experiment reported, with per-experiment cells", () => {
    seedExperimentRich("exp-a", {
      status: "running",
      by_tag: { api: { passed: 5, failed: 0 }, e2e: { passed: 1, failed: 1 } },
    });
    seedExperimentRich("exp-b", {
      status: "running",
      by_tag: { api: { passed: 3, failed: 2 }, infra: { passed: 1, failed: 0 } },
    });
    const report = compareExperiments(tdd, "F1");
    expect(report.matrix.map((m) => m.tag)).toEqual(["api", "e2e", "infra"]);

    const api = report.matrix.find((m) => m.tag === "api")!;
    expect(api.cells["exp-a"]).toEqual({ passed: 5, failed: 0 });
    expect(api.cells["exp-b"]).toEqual({ passed: 3, failed: 2 });

    const e2e = report.matrix.find((m) => m.tag === "e2e")!;
    expect(e2e.cells["exp-a"]).toEqual({ passed: 1, failed: 1 });
    expect(e2e.cells["exp-b"]).toBeNull(); // exp-b reported no e2e

    const infra = report.matrix.find((m) => m.tag === "infra")!;
    expect(infra.cells["exp-a"]).toBeNull();
    expect(infra.cells["exp-b"]).toEqual({ passed: 1, failed: 0 });
  });

  it("matrix is empty when no experiment reported per-tag outcomes", () => {
    seedExperimentRich("exp-flat", { status: "running", tests_passed: 5 });
    const report = compareExperiments(tdd, "F1");
    expect(report.matrix).toEqual([]);
  });
});
