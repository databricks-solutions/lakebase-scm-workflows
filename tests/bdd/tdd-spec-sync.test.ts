import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  validateSpec,
  readFeature,
  writeFeature,
  readWorkflowState,
  writeWorkflowState,
  type Feature,
  type WorkflowState,
} from "../../scripts/tdd/spec-sync";

let tdd: string;

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-spec-"));
  mkdirSync(join(tdd, "features", "F1-test-feature", "stories", "S1-test-story", "acs"), { recursive: true });
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

function fixture(): Feature {
  return {
    id: "F1",
    name: "Test Feature",
    status: "draft",
    tdd_mode: "N=1",
    stories: ["S1"],
  };
}

describe("spec-sync", () => {
  it("round-trips a feature: write then read returns the same object", () => {
    const feature = fixture();
    const featureDir = join(tdd, "features", "F1-test-feature");
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify(feature));
    writeFileSync(join(featureDir, "feature.md"), "# Test Feature\n\nNarrative text.\n");
    const round = readFeature(tdd, "F1");
    expect(round).toEqual(feature);
  });

  it("writeFeature updates feature.json", () => {
    const feature = fixture();
    const featureDir = join(tdd, "features", "F1-test-feature");
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify(feature));
    writeFileSync(join(featureDir, "feature.md"), "# Test Feature\n\nNarrative text.\n");
    const updated: Feature = { ...feature, status: "spec-approved" };
    writeFeature(tdd, updated);
    const round = readFeature(tdd, "F1");
    expect(round.status).toBe("spec-approved");
  });

  it("validateSpec returns no reports for a valid tree", () => {
    const feature = fixture();
    const featureDir = join(tdd, "features", "F1-test-feature");
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify(feature));
    writeFileSync(join(featureDir, "feature.md"), "# Test Feature\n\nNarrative text long enough to pass length check.\n");
    const storyDir = join(featureDir, "stories", "S1-test-story");
    writeFileSync(
      join(storyDir, "story.json"),
      JSON.stringify({ id: "S1", asA: "user", iWantTo: "do thing", soThat: "outcome", feature_id: "F1" })
    );
    writeFileSync(join(storyDir, "story.md"), "# Story\n\nNarrative long enough to satisfy length check.\n");
    const ac = {
      id: "AC1",
      layer: "API",
      given: "g",
      when: "w",
      then: "t",
      status: "draft",
      story_id: "S1",
    };
    writeFileSync(join(storyDir, "acs", "AC1.json"), JSON.stringify(ac));
    writeFileSync(join(storyDir, "acs", "AC1.md"), "# AC1\n\nAC narrative.\n");
    expect(validateSpec(tdd)).toEqual([]);
  });

  it("validateSpec reports schema violation for malformed feature.json", () => {
    const featureDir = join(tdd, "features", "F1-test-feature");
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify({ id: "F1", name: "X" }));
    writeFileSync(join(featureDir, "feature.md"), "# X\n\nLong enough narrative body.\n");
    const reports = validateSpec(tdd);
    expect(reports.find((r) => r.kind === "schema")).toBeTruthy();
  });

  it("validateSpec reports pair-missing when .md is absent", () => {
    const feature = fixture();
    const featureDir = join(tdd, "features", "F1-test-feature");
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify(feature));
    const reports = validateSpec(tdd);
    expect(reports.find((r) => r.kind === "pair-missing")).toBeTruthy();
  });

  it("validateSpec reports narrative-empty when .md is too short", () => {
    const feature = fixture();
    const featureDir = join(tdd, "features", "F1-test-feature");
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify(feature));
    writeFileSync(join(featureDir, "feature.md"), "x");
    const reports = validateSpec(tdd);
    expect(reports.find((r) => r.kind === "narrative-empty")).toBeTruthy();
  });

  it("validateSpec reports id-mismatch when dir name disagrees with id", () => {
    const featureDir = join(tdd, "features", "Z9-wrong-dir");
    mkdirSync(featureDir, { recursive: true });
    const feature = { ...fixture(), id: "F1" };
    writeFileSync(join(featureDir, "feature.json"), JSON.stringify(feature));
    writeFileSync(join(featureDir, "feature.md"), "# X\n\nLong enough narrative body here.\n");
    const reports = validateSpec(tdd);
    expect(reports.find((r) => r.kind === "id-mismatch")).toBeTruthy();
  });

  it("writeWorkflowState / readWorkflowState round-trip", () => {
    const state: WorkflowState = {
      phase: "implementation",
      started_at: new Date().toISOString(),
      feature_id: "F1",
    };
    writeWorkflowState(tdd, state);
    const round = readWorkflowState(tdd);
    expect(round).toEqual(state);
  });

  it("readWorkflowState returns null when no state file exists", () => {
    expect(readWorkflowState(tdd)).toBeNull();
  });
});
