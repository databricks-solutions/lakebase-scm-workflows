import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeMasterTestList } from "../../scripts/tdd/test-list";
import { analyzeForGate, recordPlan, writePlan, readPlan } from "../../scripts/tdd/design-spec-gate";

let tdd: string;
const FEATURE_DIR = "features/F1-test-feature";

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-gate-"));
  mkdirSync(join(tdd, FEATURE_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("design-spec-gate", () => {
  it("proposes N=1 when fewer than 2 opinion gaps are detected", () => {
    writeMasterTestList(tdd, {
      feature_id: "F1",
      items: [
        { id: "T1", description: "happy path returns 200", ac_id: "AC1", status: "pending" },
        { id: "T2", description: "rejects invalid input with 400", ac_id: "AC1", status: "pending" },
      ],
    });
    const analysis = analyzeForGate(tdd, "F1");
    expect(analysis.proposed_plan.mode).toBe("N=1");
    expect(analysis.proposed_plan.N).toBe(1);
    expect(analysis.proposed_plan.strategies.length).toBe(1);
  });

  it("proposes N>=2 when opinion-gap keywords appear in 2+ items", () => {
    writeMasterTestList(tdd, {
      feature_id: "F1",
      items: [
        { id: "T1", description: "either postgres arrays or json blob – decide", ac_id: "AC1", status: "pending" },
        { id: "T2", description: "consider whether to denormalize", ac_id: "AC1", status: "pending" },
        { id: "T3", description: "happy path", ac_id: "AC2", status: "pending" },
      ],
    });
    const analysis = analyzeForGate(tdd, "F1");
    expect(analysis.proposed_plan.mode).toBe("N>=2");
    expect(analysis.proposed_plan.N).toBeGreaterThanOrEqual(2);
    expect(analysis.opinion_gaps.length).toBeGreaterThanOrEqual(2);
    expect(analysis.proposed_plan.strategies.length).toBe(analysis.proposed_plan.N);
  });

  it("caps strategies at 3 even with more gaps detected", () => {
    writeMasterTestList(tdd, {
      feature_id: "F1",
      items: Array.from({ length: 5 }, (_, i) => ({
        id: `T${i + 1}`,
        description: `consider option ${i} or alternatively...`,
        ac_id: "AC1",
        status: "pending" as const,
      })),
    });
    const analysis = analyzeForGate(tdd, "F1");
    expect(analysis.proposed_plan.N).toBeLessThanOrEqual(3);
    expect(analysis.proposed_plan.strategies.length).toBeLessThanOrEqual(3);
  });

  it("recordPlan appends a structured entry to selection-log.md", () => {
    writeMasterTestList(tdd, {
      feature_id: "F1",
      items: [{ id: "T1", description: "happy path", ac_id: "AC1", status: "pending" }],
    });
    const analysis = analyzeForGate(tdd, "F1");
    recordPlan(tdd, analysis.proposed_plan, "kevin.hartman@databricks.com");
    const log = readFileSync(join(tdd, "selection-log.md"), "utf8");
    expect(log).toContain("Experiment plan for F1");
    expect(log).toContain("Mode:");
    expect(log).toContain("kevin.hartman@databricks.com");
  });

  it("writePlan/readPlan round-trip persists plan to features/<F>/plan.json", () => {
    writeMasterTestList(tdd, {
      feature_id: "F1",
      items: [{ id: "T1", description: "happy path", ac_id: "AC1", status: "pending" }],
    });
    const analysis = analyzeForGate(tdd, "F1");
    writePlan(tdd, analysis.proposed_plan);
    expect(existsSync(join(tdd, "features", "F1", "plan.json"))).toBe(true);
    const round = readPlan(tdd, "F1");
    expect(round).toEqual(analysis.proposed_plan);
  });

  it("readPlan returns null when no plan has been written", () => {
    expect(readPlan(tdd, "F1")).toBeNull();
  });
});
