import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  beginCycle,
  markGreen,
  markRefactored,
  flagSmells,
  listCycles,
  nextCycleId,
  readCycleArtifact,
  openBranchDsn,
  type CycleScope,
} from "../../scripts/tdd/run-cycle";

const LIVE = process.env.LAKEBASE_TEST_E2E === "1" && !!process.env.DATABRICKS_HOST;

let tdd: string;
let scope: CycleScope;

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-cycle-"));
  scope = { tddDir: tdd, feature_id: "F1", story_id: "S1", ac_id: "AC1" };
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("run-cycle (hermetic)", () => {
  it("nextCycleId returns cycle-001 when no cycles exist", () => {
    expect(nextCycleId(scope)).toBe("cycle-001");
  });

  it("nextCycleId auto-increments across written cycles", () => {
    beginCycle({ ...scope, test_id: "T1", test_description: "first" });
    expect(nextCycleId(scope)).toBe("cycle-002");
    beginCycle({ ...scope, test_id: "T2", test_description: "second" });
    expect(nextCycleId(scope)).toBe("cycle-003");
  });

  it("beginCycle persists artifact with red_at and navigator plan", () => {
    const a = beginCycle({
      ...scope,
      test_id: "T1",
      test_description: "force API shape",
      navigator_plan: "force the public boundary to accept a single arg",
    });
    expect(a.cycle_id).toBe("cycle-001");
    expect(a.red_at).toBeTruthy();
    expect(a.navigator_plan).toContain("public boundary");
    expect(existsSync(join(tdd, "cycles", "F1", "S1", "AC1", "cycle-001.json"))).toBe(true);
  });

  it("markGreen sets green_at + passed verdict", () => {
    const a = beginCycle({ ...scope, test_id: "T1", test_description: "x" });
    const g = markGreen(scope, a.cycle_id, "added handler.ts and returned constant");
    expect(g.green_at).toBeTruthy();
    expect(g.navigator_verdict).toBe("passed");
    expect(g.driver_changes).toContain("constant");
  });

  it("markRefactored sets refactored_at and notes", () => {
    const a = beginCycle({ ...scope, test_id: "T1", test_description: "x" });
    markGreen(scope, a.cycle_id);
    const r = markRefactored(scope, a.cycle_id, "extracted helper");
    expect(r.refactored_at).toBeTruthy();
    expect(r.refactor_notes).toBe("extracted helper");
  });

  it("flagSmells accumulates unique smell flags", () => {
    const a = beginCycle({ ...scope, test_id: "T1", test_description: "x" });
    flagSmells(scope, a.cycle_id, ["cycle-stall"]);
    const final = flagSmells(scope, a.cycle_id, ["cycle-stall", "test-cost-spiral"]);
    expect(final.smell_flags).toEqual(["cycle-stall", "test-cost-spiral"]);
  });

  it("listCycles returns artifacts in cycle-id order", () => {
    beginCycle({ ...scope, test_id: "T1", test_description: "a" });
    beginCycle({ ...scope, test_id: "T2", test_description: "b" });
    beginCycle({ ...scope, test_id: "T3", test_description: "c" });
    const list = listCycles(scope);
    expect(list.map((c) => c.cycle_id)).toEqual(["cycle-001", "cycle-002", "cycle-003"]);
  });

  it("readCycleArtifact returns null for missing cycle", () => {
    expect(readCycleArtifact(scope, "cycle-999")).toBeNull();
  });

  it("markGreen throws when cycle does not exist", () => {
    expect(() => markGreen(scope, "cycle-999")).toThrow(/not found/);
  });
});

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("run-cycle (live – LAKEBASE_TEST_E2E=1)", () => {
  it("openBranchDsn returns a DSN that resolves to the experiment branch", async () => {
    const instance = process.env.LAKEBASE_TEST_INSTANCE!;
    const branch = process.env.LAKEBASE_TEST_BRANCH!;
    const dsn = await openBranchDsn({ instance, branch_id: branch });
    expect(dsn.url).toMatch(/^postgres(?:ql)?:\/\//);
    expect(dsn.database).toBeTruthy();
  }, 120_000);
});
