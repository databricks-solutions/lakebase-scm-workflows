import { listExperiments, readOutcomes } from "./experiment";
import type { ExperimentOutcomes } from "./experiment";

export interface ExperimentRow {
  experiment_slug: string;
  branch_id: string;
  status: ExperimentOutcomes["status"] | "unknown";
  tests_passed?: number;
  tests_failed?: number;
  schema_diff_summary?: string;
  code_diff_lines?: number;
  signal: "winning" | "stalled" | "abandoned" | "running" | "unknown";
}

export interface ComparisonReport {
  feature_id: string;
  generated_at: string;
  rows: ExperimentRow[];
  recommendation: "promote" | "synthesize" | "continue" | "abandon-all";
  rationale: string;
}

export function compareExperiments(tddDir: string, featureId: string): ComparisonReport {
  const experiments = listExperiments(tddDir, featureId);
  const rows: ExperimentRow[] = experiments.map((exp) => {
    const o = readOutcomes(tddDir, featureId, exp.experiment_slug);
    return {
      experiment_slug: exp.experiment_slug,
      branch_id: exp.branch_id,
      status: o?.status ?? "unknown",
      tests_passed: o?.tests_passed,
      tests_failed: o?.tests_failed,
      schema_diff_summary: o?.schema_diff_summary,
      code_diff_lines: o?.code_diff_lines,
      signal: classifySignal(o),
    };
  });
  const { recommendation, rationale } = recommend(rows);
  return {
    feature_id: featureId,
    generated_at: new Date().toISOString(),
    rows,
    recommendation,
    rationale,
  };
}

function classifySignal(o: ExperimentOutcomes | null): ExperimentRow["signal"] {
  if (!o) return "unknown";
  if (o.status === "succeeded" && (o.tests_failed ?? 0) === 0 && (o.tests_passed ?? 0) > 0) {
    return "winning";
  }
  if (o.status === "failed") return "stalled";
  if (o.status === "abandoned") return "abandoned";
  if (o.status === "running") return "running";
  return "unknown";
}

function recommend(rows: ExperimentRow[]): { recommendation: ComparisonReport["recommendation"]; rationale: string } {
  const winners = rows.filter((r) => r.signal === "winning");
  const running = rows.filter((r) => r.signal === "running");
  const stalled = rows.filter((r) => r.signal === "stalled");

  if (winners.length === 1 && running.length === 0) {
    return {
      recommendation: "promote",
      rationale: `1 winning experiment, no others still running — promote ${winners[0].experiment_slug}.`,
    };
  }
  if (winners.length >= 2) {
    return {
      recommendation: "synthesize",
      rationale: `${winners.length} winning experiments — Product Owner menu-picks; spec gets renegotiated.`,
    };
  }
  if (winners.length === 0 && running.length === 0 && stalled.length === rows.length && rows.length > 0) {
    return {
      recommendation: "abandon-all",
      rationale: `All ${rows.length} experiments stalled — re-run design-spec gate.`,
    };
  }
  return {
    recommendation: "continue",
    rationale: `${winners.length} winning, ${running.length} running, ${stalled.length} stalled — let cycles finish or HITL intervene.`,
  };
}
