import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { writeWorkflowState, readWorkflowState, writeFeature } from "../../scripts/tdd/spec-sync";
import { writeMasterTestList } from "../../scripts/tdd/test-list";
import { analyzeForGate, recordPlan, writePlan } from "../../scripts/tdd/design-spec-gate";
import { beginCycle, markGreen, listCycles } from "../../scripts/tdd/run-cycle";
import { runDetectorsForScope, writeSmellsLog, readSmellsLog } from "../../scripts/tdd/smells";

const LIVE = process.env.LAKEBASE_TEST_E2E === "1" && !!process.env.DATABRICKS_HOST;

let tdd: string;

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-orch-"));
  mkdirSync(join(tdd, "features", "F1-test", "stories", "S1-test", "acs"), { recursive: true });
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("orchestrator e2e (hermetic — stubbed Navigator + Driver, real script primitives)", () => {
  it("walks phases 0 -> 1 -> 2 -> 3 -> 4 with HITL-recorded gates and persists every artifact", () => {
    // --- Phase 0: Discovery ---
    writeWorkflowState(tdd, { phase: "discovery", started_at: new Date().toISOString() });

    writeFeature(tdd, {
      id: "F1",
      name: "Test feature",
      status: "draft",
      tdd_mode: "N=1",
      stories: ["S1"],
    });
    writeFileSync(
      join(tdd, "features", "F1-test", "feature.md"),
      "# Test feature\n\nNarrative long enough to satisfy length check.\n"
    );

    // HITL Gate 1 approval (simulated)
    writeWorkflowState(tdd, {
      phase: "architectural-review",
      feature_id: "F1",
      started_at: new Date().toISOString(),
      last_transition_at: new Date().toISOString(),
      last_transition_by: "kevin@example.com",
    });
    expect(readWorkflowState(tdd)?.phase).toBe("architectural-review");

    // --- Phase 1: Architectural review (Architect Reviewer is markdown-driven; we simulate its output) ---
    writeFileSync(join(tdd, "features", "F1-test", "architecture.md"), "# Architecture\n\nLayered.\n");

    // HITL Gate 2 approval
    writeWorkflowState(tdd, {
      phase: "test-list-construction",
      feature_id: "F1",
      started_at: new Date().toISOString(),
      last_transition_by: "kevin@example.com",
    });

    // --- Phase 2: Test-list construction ---
    writeMasterTestList(tdd, {
      feature_id: "F1",
      ordered_for: "design-momentum",
      items: [
        { id: "T1", description: "happy path returns 200", ac_id: "AC1", status: "pending" },
        { id: "T2", description: "rejects invalid input", ac_id: "AC1", status: "pending" },
      ],
    });

    // HITL Gate 3 approval
    writeWorkflowState(tdd, {
      phase: "design-spec-gate",
      feature_id: "F1",
      started_at: new Date().toISOString(),
      last_transition_by: "kevin@example.com",
    });

    // --- Phase 3: Design-spec gate ---
    const analysis = analyzeForGate(tdd, "F1");
    expect(analysis.proposed_plan.mode).toBe("N=1");
    recordPlan(tdd, analysis.proposed_plan, "kevin@example.com");
    writePlan(tdd, analysis.proposed_plan);
    expect(existsSync(join(tdd, "features", "F1", "plan.json"))).toBe(true);
    expect(readFileSync(join(tdd, "selection-log.md"), "utf8")).toContain("Experiment plan for F1");

    // HITL Gate 4 approval — transition to implementation
    writeWorkflowState(tdd, {
      phase: "implementation",
      feature_id: "F1",
      story_id: "S1",
      ac_id: "AC1",
      started_at: new Date().toISOString(),
      last_transition_by: "kevin@example.com",
    });

    // --- Phase 4: Implementation (stubbed Navigator + Driver) ---
    const scope = { tddDir: tdd, feature_id: "F1", story_id: "S1", ac_id: "AC1" };
    const c1 = beginCycle({
      ...scope,
      test_id: "T1",
      test_description: "happy path returns 200",
      navigator_plan: "force the public boundary to return 200",
    });
    markGreen(scope, c1.cycle_id, "added handler returning 200");

    const c2 = beginCycle({ ...scope, test_id: "T2", test_description: "rejects invalid input" });
    markGreen(scope, c2.cycle_id, "added validator + error path");

    const cycles = listCycles(scope);
    expect(cycles.length).toBe(2);
    expect(cycles.every((c) => c.green_at)).toBe(true);

    // Smell detection runs after every cycle pair — no smells expected for a clean run
    const hits = runDetectorsForScope(tdd, scope);
    expect(hits).toEqual([]);
    writeSmellsLog(tdd, hits);
    expect(readSmellsLog(tdd).detected).toEqual([]);

    // Phase 4 -> review (N=1 outcome: branch IS the feature; no promote ceremony)
    writeWorkflowState(tdd, {
      phase: "review",
      feature_id: "F1",
      story_id: "S1",
      ac_id: "AC1",
      started_at: new Date().toISOString(),
      last_transition_by: "kevin@example.com",
    });
    expect(readWorkflowState(tdd)?.phase).toBe("review");
  });

  it("surfaces cycle-stall when 3 consecutive cycles have no GREEN", () => {
    const scope = { tddDir: tdd, feature_id: "F1", story_id: "S1", ac_id: "AC1" };
    beginCycle({ ...scope, test_id: "T1", test_description: "x" });
    beginCycle({ ...scope, test_id: "T2", test_description: "y" });
    beginCycle({ ...scope, test_id: "T3", test_description: "z" });

    const hits = runDetectorsForScope(tdd, scope);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.smell === "cycle-stall")).toBe(true);
    writeSmellsLog(tdd, hits);
    expect(readSmellsLog(tdd).detected.length).toBeGreaterThanOrEqual(1);
  });
});

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("orchestrator e2e (live — LAKEBASE_TEST_E2E=1)", () => {
  it("end-to-end smoke: branch primitive available + getConnection resolves", async () => {
    // The hermetic test exercises the orchestration shape; the live tier asserts that
    // the Lakebase-backed primitives the orchestrator depends on resolve in a real env.
    const { openBranchDsn } = await import("../../scripts/tdd/run-cycle");
    const instance = process.env.LAKEBASE_TEST_INSTANCE!;
    const branch = process.env.LAKEBASE_TEST_BRANCH!;
    const dsn = await openBranchDsn({ instance, branch_id: branch });
    expect(dsn.url).toMatch(/^postgres(?:ql)?:\/\//);
  }, 120_000);
});
