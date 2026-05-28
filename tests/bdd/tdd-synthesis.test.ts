import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { synthesizeExperiments } from "../../scripts/tdd/synthesis";

const LIVE = process.env.LAKEBASE_TEST_E2E === "1" && !!process.env.DATABRICKS_HOST;

let tdd: string;

function seedExperiment(slug: string): void {
  const dir = join(tdd, "experiments", "F1", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch.txt"), `feature/${slug}`);
}

function seedFeature(): void {
  const dir = join(tdd, "features", "F1-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "feature.json"),
    JSON.stringify({ id: "F1", name: "Test", status: "in-progress", tdd_mode: "N>=2" })
  );
  writeFileSync(join(dir, "feature.md"), "# Test feature\n");
}

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-synth-"));
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("synthesizeExperiments (hermetic – pre-cut validation + on-disk side effects)", () => {
  it("throws when hitlApproved is false", async () => {
    await expect(
      synthesizeExperiments({
        instance: "irrelevant",
        tddDir: tdd,
        featureId: "F1",
        picks: [
          { source_slug: "a", capability: "x" },
          { source_slug: "b", capability: "y" },
        ],
        synthesizedSlug: "exp-synth",
        branch: "exp-synth",
        hitlApproved: false,
      })
    ).rejects.toThrow(/HITL/);
  });

  it("throws when fewer than 2 picks provided", async () => {
    seedExperiment("exp-a");
    await expect(
      synthesizeExperiments({
        instance: "irrelevant",
        tddDir: tdd,
        featureId: "F1",
        picks: [{ source_slug: "exp-a", capability: "only" }],
        synthesizedSlug: "exp-synth",
        branch: "exp-synth",
        hitlApproved: true,
      })
    ).rejects.toThrow(/at least 2/);
  });

  it("throws when a pick source is not an experiment of the feature", async () => {
    seedExperiment("exp-a");
    await expect(
      synthesizeExperiments({
        instance: "irrelevant",
        tddDir: tdd,
        featureId: "F1",
        picks: [
          { source_slug: "exp-a", capability: "x" },
          { source_slug: "ghost", capability: "y" },
        ],
        synthesizedSlug: "exp-synth",
        branch: "exp-synth",
        hitlApproved: true,
      })
    ).rejects.toThrow(/ghost is not an experiment/);
  });

  it("writes the decision record + synthesized-spec subtree before attempting to cut a branch", async () => {
    seedFeature();
    seedExperiment("exp-a");
    seedExperiment("exp-b");
    try {
      await synthesizeExperiments({
        instance: "irrelevant",
        tddDir: tdd,
        featureId: "F1",
        picks: [
          { source_slug: "exp-a", capability: "schema design" },
          { source_slug: "exp-b", capability: "API shape" },
        ],
        synthesizedSlug: "exp-synth",
        branch: "exp-synth",
        hitlApproved: true,
        approverEmail: "kevin@example.com",
      });
    } catch {
      // Expected when not running live – cutExperiment will reach for Lakebase and fail.
      // The on-disk side effects (decision + spec subtree + selection-log) happen first
      // and are what we assert here.
    }
    const synthesisDir = join(tdd, "synthesis", "F1");
    expect(existsSync(synthesisDir)).toBe(true);
    const synthesizedSpec = join(synthesisDir, "synthesized-spec");
    expect(existsSync(synthesizedSpec)).toBe(true);
    expect(existsSync(join(synthesizedSpec, "README.md"))).toBe(true);
    const seededCopy = join(synthesizedSpec, "feature", "feature.json");
    expect(existsSync(seededCopy)).toBe(true);
    const log = readFileSync(join(tdd, "selection-log.md"), "utf8");
    expect(log).toContain("Synthesize F1");
    expect(log).toContain("exp-a: schema design");
    expect(log).toContain("exp-b: API shape");
    expect(log).toContain("kevin@example.com");
  });
});

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("synthesizeExperiments (live – LAKEBASE_TEST_E2E=1)", () => {
  it("cuts a fresh branch for the renegotiated cycle", async () => {
    seedFeature();
    seedExperiment("exp-a");
    seedExperiment("exp-b");
    const instance = process.env.LAKEBASE_TEST_INSTANCE!;
    const result = await synthesizeExperiments({
      instance,
      tddDir: tdd,
      featureId: "F1",
      picks: [
        { source_slug: "exp-a", capability: "schema design" },
        { source_slug: "exp-b", capability: "API shape" },
      ],
      synthesizedSlug: `synth-${Date.now()}`,
      branch: `synth-${Date.now()}`,
      hitlApproved: true,
    });
    expect(result.fresh_experiment.branch_id).toBeTruthy();
  }, 600_000);
});
