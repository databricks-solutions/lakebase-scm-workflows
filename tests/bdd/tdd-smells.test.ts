import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SMELL_CATALOG,
  detectAll,
  detectCycleStall,
  detectFragilityRatio,
  detectTestCostSpiral,
  detectTestDeletionAttempt,
  detectBoundaryViolation,
  detectTestListDrift,
  writeSmellsLog,
  readSmellsLog,
} from "../../scripts/tdd/smells";
import type { CycleArtifact, CycleScope } from "../../scripts/tdd/run-cycle";

let tdd: string;
const scope: CycleScope = { tddDir: "", feature_id: "F1", story_id: "S1", ac_id: "AC1" };

function artifact(overrides: Partial<CycleArtifact>): CycleArtifact {
  return {
    cycle_id: "cycle-001",
    feature_id: "F1",
    story_id: "S1",
    ac_id: "AC1",
    test_id: "T1",
    test_description: "x",
    ...overrides,
  };
}

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-smells-"));
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("smells catalog", () => {
  it("ships all 9 smell entries from spec section 9", () => {
    const names = SMELL_CATALOG.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "api-coherence-drift",
        "boundary-violation",
        "cross-experiment-divergence",
        "cycle-stall",
        "dead-requirement-signal",
        "fragility-ratio",
        "test-cost-spiral",
        "test-deletion-attempt",
        "test-list-drift",
      ].sort()
    );
  });

  it("every catalog entry has a description and a proposed remediation", () => {
    for (const entry of SMELL_CATALOG) {
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.proposed_remediation.length).toBeGreaterThan(10);
    }
  });
});

describe("smells detectors", () => {
  it("detectCycleStall flags 3 consecutive cycles with no GREEN", () => {
    const cycles = [
      artifact({ cycle_id: "cycle-001" }),
      artifact({ cycle_id: "cycle-002" }),
      artifact({ cycle_id: "cycle-003" }),
    ];
    const hits = detectCycleStall({ scope, cycles });
    expect(hits.length).toBe(1);
    expect(hits[0].smell).toBe("cycle-stall");
  });

  it("detectCycleStall does not fire when at least one recent cycle is GREEN", () => {
    const cycles = [
      artifact({ cycle_id: "cycle-001" }),
      artifact({ cycle_id: "cycle-002", green_at: new Date().toISOString() }),
      artifact({ cycle_id: "cycle-003" }),
    ];
    expect(detectCycleStall({ scope, cycles })).toEqual([]);
  });

  it("detectFragilityRatio flags Navigator-flagged cycles", () => {
    const cycles = [artifact({ smell_flags: ["fragility-ratio"] })];
    const hits = detectFragilityRatio({ scope, cycles });
    expect(hits.length).toBe(1);
    expect(hits[0].smell).toBe("fragility-ratio");
  });

  it("detectTestCostSpiral flags >2x growth in driver_changes char count", () => {
    const cycles = [
      artifact({ cycle_id: "cycle-001", driver_changes: "a".repeat(50) }),
      artifact({ cycle_id: "cycle-002", driver_changes: "a".repeat(150) }),
    ];
    const hits = detectTestCostSpiral({ scope, cycles });
    expect(hits.length).toBe(1);
    expect(hits[0].smell).toBe("test-cost-spiral");
  });

  it("detectTestDeletionAttempt + detectBoundaryViolation pass through Navigator flags", () => {
    const cycles = [
      artifact({ cycle_id: "cycle-001", smell_flags: ["test-deletion-attempt", "boundary-violation"] }),
    ];
    expect(detectTestDeletionAttempt({ scope, cycles })[0]?.smell).toBe("test-deletion-attempt");
    expect(detectBoundaryViolation({ scope, cycles })[0]?.smell).toBe("boundary-violation");
  });

  it("detectTestListDrift flags >25% growth", () => {
    const hits = detectTestListDrift({
      scope,
      cycles: [],
      test_list_size_at_start: 4,
      test_list_size_now: 6,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].smell).toBe("test-list-drift");
  });

  it("detectTestListDrift does not fire under 25% growth", () => {
    expect(
      detectTestListDrift({
        scope,
        cycles: [],
        test_list_size_at_start: 10,
        test_list_size_now: 12,
      })
    ).toEqual([]);
  });

  it("detectAll aggregates hits from every individual detector", () => {
    const cycles = [
      artifact({ cycle_id: "cycle-001", driver_changes: "x".repeat(10), smell_flags: ["fragility-ratio"] }),
      artifact({ cycle_id: "cycle-002", driver_changes: "x".repeat(30) }),
      artifact({ cycle_id: "cycle-003", smell_flags: ["boundary-violation"] }),
      artifact({ cycle_id: "cycle-004" }),
      artifact({ cycle_id: "cycle-005" }),
    ];
    const hits = detectAll({ scope, cycles });
    const smellNames = new Set(hits.map((h) => h.smell));
    expect(smellNames.has("fragility-ratio")).toBe(true);
    expect(smellNames.has("boundary-violation")).toBe(true);
    expect(smellNames.has("test-cost-spiral")).toBe(true);
    expect(smellNames.has("cycle-stall")).toBe(true);
  });

  it("writeSmellsLog persists detected hits and readSmellsLog reads them back", () => {
    const hits = [{ smell: "cycle-stall" as const, cycle_ids: ["cycle-001"], detail: "x" }];
    writeSmellsLog(tdd, hits);
    expect(existsSync(join(tdd, "smells.json"))).toBe(true);
    const log = readSmellsLog(tdd);
    expect(log.detected.length).toBe(1);
    expect(log.detected[0].smell).toBe("cycle-stall");
    expect(log.detected[0].detected_at).toBeTruthy();
  });

  it("readSmellsLog returns empty when no log exists", () => {
    expect(readSmellsLog(tdd)).toEqual({ detected: [] });
  });
});
