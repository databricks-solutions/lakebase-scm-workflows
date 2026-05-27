import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { listCycles } from "./run-cycle";
import type { CycleScope, CycleArtifact } from "./run-cycle";

export type SmellName =
  | "test-list-drift"
  | "cycle-stall"
  | "api-coherence-drift"
  | "fragility-ratio"
  | "test-cost-spiral"
  | "cross-experiment-divergence"
  | "dead-requirement-signal"
  | "test-deletion-attempt"
  | "boundary-violation";

export interface SmellDefinition {
  name: SmellName;
  description: string;
  proposed_remediation: string;
}

export const SMELL_CATALOG: SmellDefinition[] = [
  {
    name: "test-list-drift",
    description: "Test list grew by >25% since cycle start without HITL approval.",
    proposed_remediation: "PO refinement on spec.",
  },
  {
    name: "cycle-stall",
    description: "N cycles in a row with no GREEN.",
    proposed_remediation: "Re-examine test ordering or spec ambiguity.",
  },
  {
    name: "api-coherence-drift",
    description: "Same concept named differently across two consecutive PASS reviews.",
    proposed_remediation: "Rename refactor before next test.",
  },
  {
    name: "fragility-ratio",
    description: "One behavior change failed >3 tests.",
    proposed_remediation: "Refactor + flag tests-mirror-implementation anti-pattern.",
  },
  {
    name: "test-cost-spiral",
    description: "Each subsequent test takes >2x the lines of the prior one.",
    proposed_remediation: "Reconsider boundary; outer-loop tests probably needed.",
  },
  {
    name: "cross-experiment-divergence",
    description: "Two parallel experiments are solving different problems.",
    proposed_remediation: "Was an opinion gap hidden? Re-run design-spec gate.",
  },
  {
    name: "dead-requirement-signal",
    description: "An AC has had no scenarios written in N cycles while others mature.",
    proposed_remediation: "Deprecate or clarify via PO refinement.",
  },
  {
    name: "test-deletion-attempt",
    description: "Driver or human attempts to remove or weaken an existing test.",
    proposed_remediation: "Hard block. Tests are immutable until the test list itself is renegotiated.",
  },
  {
    name: "boundary-violation",
    description: "Test references a private method or internal helper.",
    proposed_remediation: "Refactor to public boundary or move to inner-loop list.",
  },
];

export interface DetectorInput {
  scope: CycleScope;
  cycles: CycleArtifact[];
  test_list_size_at_start?: number;
  test_list_size_now?: number;
}

export interface SmellHit {
  smell: SmellName;
  cycle_ids: string[];
  detail: string;
}

const CYCLE_STALL_THRESHOLD = 3;
const FRAGILITY_RATIO_FAILED_TESTS = 3;
const TEST_COST_SPIRAL_FACTOR = 2;

export function detectAll(input: DetectorInput): SmellHit[] {
  const hits: SmellHit[] = [];
  hits.push(...detectCycleStall(input));
  hits.push(...detectFragilityRatio(input));
  hits.push(...detectTestCostSpiral(input));
  hits.push(...detectTestDeletionAttempt(input));
  hits.push(...detectBoundaryViolation(input));
  hits.push(...detectTestListDrift(input));
  return hits;
}

export function detectCycleStall(input: DetectorInput): SmellHit[] {
  const { cycles } = input;
  if (cycles.length < CYCLE_STALL_THRESHOLD) return [];
  const recent = cycles.slice(-CYCLE_STALL_THRESHOLD);
  if (recent.every((c) => !c.green_at)) {
    return [
      {
        smell: "cycle-stall",
        cycle_ids: recent.map((c) => c.cycle_id),
        detail: `${CYCLE_STALL_THRESHOLD} consecutive cycles without GREEN`,
      },
    ];
  }
  return [];
}

export function detectFragilityRatio(input: DetectorInput): SmellHit[] {
  // Flag any cycle whose Navigator already marked the fragility-ratio smell.
  return input.cycles
    .filter((c) => (c.smell_flags ?? []).includes("fragility-ratio"))
    .map((c) => ({
      smell: "fragility-ratio" as const,
      cycle_ids: [c.cycle_id],
      detail: `Navigator-flagged: one behavior change failed >${FRAGILITY_RATIO_FAILED_TESTS} tests`,
    }));
}

export function detectTestCostSpiral(input: DetectorInput): SmellHit[] {
  const sized = input.cycles.filter((c) => c.driver_changes);
  if (sized.length < 2) return [];
  const hits: SmellHit[] = [];
  for (let i = 1; i < sized.length; i++) {
    const prev = sized[i - 1].driver_changes!.length;
    const curr = sized[i].driver_changes!.length;
    if (prev > 0 && curr > prev * TEST_COST_SPIRAL_FACTOR) {
      hits.push({
        smell: "test-cost-spiral",
        cycle_ids: [sized[i - 1].cycle_id, sized[i].cycle_id],
        detail: `driver_changes grew from ${prev} → ${curr} chars (>${TEST_COST_SPIRAL_FACTOR}x)`,
      });
    }
  }
  return hits;
}

export function detectTestDeletionAttempt(input: DetectorInput): SmellHit[] {
  return input.cycles
    .filter((c) => (c.smell_flags ?? []).includes("test-deletion-attempt"))
    .map((c) => ({
      smell: "test-deletion-attempt" as const,
      cycle_ids: [c.cycle_id],
      detail: "Navigator-flagged: Driver or human attempted to remove or weaken a test",
    }));
}

export function detectBoundaryViolation(input: DetectorInput): SmellHit[] {
  return input.cycles
    .filter((c) => (c.smell_flags ?? []).includes("boundary-violation"))
    .map((c) => ({
      smell: "boundary-violation" as const,
      cycle_ids: [c.cycle_id],
      detail: "Navigator-flagged: test references a private method or internal helper",
    }));
}

export function detectTestListDrift(input: DetectorInput): SmellHit[] {
  const { test_list_size_at_start, test_list_size_now, scope } = input;
  if (test_list_size_at_start === undefined || test_list_size_now === undefined) return [];
  if (test_list_size_at_start === 0) return [];
  const growth = (test_list_size_now - test_list_size_at_start) / test_list_size_at_start;
  if (growth > 0.25) {
    return [
      {
        smell: "test-list-drift",
        cycle_ids: [],
        detail: `Test list grew ${Math.round(growth * 100)}% since cycle start (>25%) in ${scope.feature_id}/${scope.story_id}/${scope.ac_id}`,
      },
    ];
  }
  return [];
}

export interface SmellsLog {
  detected: Array<SmellHit & { detected_at: string; resolution?: string }>;
}

export function writeSmellsLog(tddDir: string, hits: SmellHit[]): SmellsLog {
  const file = join(tddDir, "smells.json");
  const existing: SmellsLog = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { detected: [] };
  const ts = new Date().toISOString();
  const newEntries = hits.map((h) => ({ ...h, detected_at: ts }));
  const merged: SmellsLog = { detected: [...existing.detected, ...newEntries] };
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function readSmellsLog(tddDir: string): SmellsLog {
  const file = join(tddDir, "smells.json");
  if (!existsSync(file)) return { detected: [] };
  return JSON.parse(readFileSync(file, "utf8"));
}

export function runDetectorsForScope(
  tddDir: string,
  scope: CycleScope,
  testListSizeAtStart?: number,
  testListSizeNow?: number
): SmellHit[] {
  const cycles = listCycles(scope);
  return detectAll({
    scope,
    cycles,
    test_list_size_at_start: testListSizeAtStart,
    test_list_size_now: testListSizeNow,
  });
}
