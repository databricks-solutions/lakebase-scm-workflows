import { listExperiments } from "./experiment";
import { readPlan } from "./design-spec-gate";
import type { ExperimentOutcomes } from "./experiment";
import { readOutcomes } from "./experiment";

export interface BudgetSnapshot {
  feature_id: string;
  concurrent_branches_in_use: number;
  concurrent_branches_limit: number;
  wall_clock_minutes_used: number;
  wall_clock_minutes_limit: number;
  agent_pairs_limit: number;
}

export interface BudgetViolation {
  kind: "concurrent-branches" | "wall-clock";
  message: string;
}

export function snapshotBudget(tddDir: string, featureId: string): BudgetSnapshot | null {
  const plan = readPlan(tddDir, featureId);
  if (!plan) return null;
  const experiments = listExperiments(tddDir, featureId);
  const inUse = experiments.filter((e) => {
    const o: ExperimentOutcomes | null = readOutcomes(tddDir, featureId, e.experiment_slug);
    return !o || o.status === "running";
  }).length;
  const wallClockMinutes =
    experiments.length === 0
      ? 0
      : Math.round(
          (Date.now() - new Date(experiments.reduce((min, e) => (e.created_at < min ? e.created_at : min), experiments[0].created_at)).getTime()) /
            60000
        );
  return {
    feature_id: featureId,
    concurrent_branches_in_use: inUse,
    concurrent_branches_limit: plan.budget.concurrent_branches,
    wall_clock_minutes_used: wallClockMinutes,
    wall_clock_minutes_limit: plan.budget.wall_clock_minutes,
    agent_pairs_limit: plan.budget.agent_pairs,
  };
}

export function checkBudget(snapshot: BudgetSnapshot): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (snapshot.concurrent_branches_in_use > snapshot.concurrent_branches_limit) {
    violations.push({
      kind: "concurrent-branches",
      message: `${snapshot.concurrent_branches_in_use} running experiments exceeds limit of ${snapshot.concurrent_branches_limit}`,
    });
  }
  if (snapshot.wall_clock_minutes_used > snapshot.wall_clock_minutes_limit) {
    violations.push({
      kind: "wall-clock",
      message: `${snapshot.wall_clock_minutes_used} min elapsed exceeds limit of ${snapshot.wall_clock_minutes_limit}`,
    });
  }
  return violations;
}

export function canCutAnotherExperiment(tddDir: string, featureId: string): { ok: boolean; reason?: string } {
  const snap = snapshotBudget(tddDir, featureId);
  if (!snap) return { ok: false, reason: "no plan recorded – run design-spec-gate first" };
  if (snap.concurrent_branches_in_use >= snap.concurrent_branches_limit) {
    return {
      ok: false,
      reason: `at concurrent-branch limit (${snap.concurrent_branches_in_use}/${snap.concurrent_branches_limit})`,
    };
  }
  if (snap.wall_clock_minutes_used >= snap.wall_clock_minutes_limit) {
    return {
      ok: false,
      reason: `wall-clock budget exhausted (${snap.wall_clock_minutes_used}/${snap.wall_clock_minutes_limit} min)`,
    };
  }
  return { ok: true };
}
