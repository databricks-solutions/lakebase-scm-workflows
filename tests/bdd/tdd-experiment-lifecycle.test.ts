import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listExperiments,
  readOutcomes,
  writeOutcomes,
  deleteExperiment,
  cutExperiment,
} from "../../scripts/tdd/experiment";

// LIVE gate must include LAKEBASE_TEST_PROJECT_PATH because the live test
// body REQUIRES it (throws "LAKEBASE_TEST_PROJECT_PATH required for live
// test" otherwise). Previously the gate accepted E2E+HOST alone, so a run
// with E2E=1 but no PROJECT_PATH would enable the describe and the test
// body would throw — surfacing as a hard FAIL instead of a clean SKIP.
const LIVE =
  process.env.LAKEBASE_TEST_E2E === "1" &&
  !!process.env.DATABRICKS_HOST &&
  !!process.env.LAKEBASE_TEST_PROJECT_PATH;

let tdd: string;

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-exp-"));
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("experiment lifecycle (hermetic)", () => {
  it("listExperiments returns empty when no experiments dir exists", () => {
    expect(listExperiments(tdd, "F1")).toEqual([]);
  });

  it("listExperiments reads existing experiment dirs", () => {
    const dir = join(tdd, "experiments", "F1", "exp-1-postgres");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "branch.txt"), "feature/test-exp-1");
    const list = listExperiments(tdd, "F1");
    expect(list.length).toBe(1);
    expect(list[0].branch_id).toBe("feature/test-exp-1");
    expect(list[0].experiment_slug).toBe("exp-1-postgres");
  });

  it("readOutcomes returns null when outcomes file is missing", () => {
    const dir = join(tdd, "experiments", "F1", "exp-1");
    mkdirSync(dir, { recursive: true });
    expect(readOutcomes(tdd, "F1", "exp-1")).toBeNull();
  });

  it("writeOutcomes then readOutcomes round-trip", () => {
    const dir = join(tdd, "experiments", "F1", "exp-1");
    mkdirSync(dir, { recursive: true });
    writeOutcomes(tdd, "F1", "exp-1", { status: "succeeded", tests_passed: 12 });
    const round = readOutcomes(tdd, "F1", "exp-1");
    expect(round?.status).toBe("succeeded");
    expect(round?.tests_passed).toBe(12);
  });

  it("writeOutcomes round-trips the per-tag breakdown (api/e2e/infra)", () => {
    const dir = join(tdd, "experiments", "F1", "exp-tags");
    mkdirSync(dir, { recursive: true });
    writeOutcomes(tdd, "F1", "exp-tags", {
      status: "running",
      tests_passed: 7,
      tests_failed: 2,
      by_tag: {
        api: { passed: 5, failed: 0 },
        e2e: { passed: 1, failed: 2 },
        infra: { passed: 1, failed: 0 },
      },
    });
    const round = readOutcomes(tdd, "F1", "exp-tags");
    expect(round?.by_tag?.api).toEqual({ passed: 5, failed: 0 });
    expect(round?.by_tag?.e2e).toEqual({ passed: 1, failed: 2 });
    expect(round?.by_tag?.infra).toEqual({ passed: 1, failed: 0 });
    // Top-level totals stay authoritative; the breakdown does not have to sum.
    expect(round?.tests_passed).toBe(7);
    expect(round?.tests_failed).toBe(2);
  });

  it("by_tag entries are individually optional (partial reporting is valid)", () => {
    const dir = join(tdd, "experiments", "F1", "exp-partial");
    mkdirSync(dir, { recursive: true });
    writeOutcomes(tdd, "F1", "exp-partial", {
      status: "running",
      tests_passed: 3,
      by_tag: { api: { passed: 3, failed: 0 } },
    });
    const round = readOutcomes(tdd, "F1", "exp-partial");
    expect(round?.by_tag?.api).toEqual({ passed: 3, failed: 0 });
    expect(round?.by_tag?.e2e).toBeUndefined();
    expect(round?.by_tag?.infra).toBeUndefined();
  });

  it("by_tag is omitted entirely when no tag breakdown is reported (backwards compatible)", () => {
    const dir = join(tdd, "experiments", "F1", "exp-no-tags");
    mkdirSync(dir, { recursive: true });
    writeOutcomes(tdd, "F1", "exp-no-tags", {
      status: "succeeded",
      tests_passed: 4,
      tests_failed: 0,
    });
    const round = readOutcomes(tdd, "F1", "exp-no-tags");
    expect(round?.by_tag).toBeUndefined();
    expect(round?.tests_passed).toBe(4);
  });

  it("deleteExperiment preserves on-disk record when deleteBranchToo is false", async () => {
    const dir = join(tdd, "experiments", "F1", "exp-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "branch.txt"), "feature/test-exp-1");
    await deleteExperiment({
      instance: "irrelevant",
      
      tddDir: tdd,
      featureId: "F1",
      experimentSlug: "exp-1",
      deleteBranchToo: false,
    });
    // Record preserved.
    expect(existsSync(join(dir, "branch.txt"))).toBe(true);
    expect(readFileSync(join(dir, "branch.txt"), "utf8")).toBe("feature/test-exp-1");
  });

  it("deleteExperiment throws when experiment does not exist", async () => {
    await expect(
      deleteExperiment({
        instance: "irrelevant",
        
        tddDir: tdd,
        featureId: "F1",
        experimentSlug: "ghost",
        deleteBranchToo: false,
      })
    ).rejects.toThrow(/not found/);
  });
});

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("experiment lifecycle (live — LAKEBASE_TEST_E2E=1)", () => {
  const projectPath = process.env.LAKEBASE_TEST_PROJECT_PATH;
  const profile = process.env.LAKEBASE_TEST_PROFILE || "DEFAULT";
  const parentBranch = process.env.LAKEBASE_TEST_PARENT || "staging";

  it("cuts and tears down a real feature branch + on-disk record", async () => {
    if (!projectPath) throw new Error("LAKEBASE_TEST_PROJECT_PATH required for live test");
    const slug = `exp-test-${Date.now()}`;
    const rec = await cutExperiment({
      instance: projectPath || "test-project",
      
      tddDir: tdd,
      featureId: "F1",
      experimentSlug: slug,
      branch: slug,
      parentBranch,
    });
    expect(rec.dir).toContain(slug);
    expect(existsSync(join(rec.dir, "branch.txt"))).toBe(true);
    expect(existsSync(join(rec.dir, "outcomes.json"))).toBe(true);
    expect(existsSync(join(rec.dir, "timeline.json"))).toBe(true);
    expect(rec.branch_id).toBeTruthy();
    await deleteExperiment({
      instance: projectPath || "test-project",
      
      tddDir: tdd,
      featureId: "F1",
      experimentSlug: slug,
      deleteBranchToo: true,
    });
  }, 600_000);
});
