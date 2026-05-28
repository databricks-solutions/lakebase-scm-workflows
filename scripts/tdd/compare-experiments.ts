import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { listExperiments, readOutcomes } from "./experiment";
import type { ExperimentOutcomes, ExperimentTag, TagOutcome } from "./experiment";
import { listArtifacts } from "./artifacts";

export interface ExperimentRow {
  experiment_slug: string;
  branch_id: string;
  status: ExperimentOutcomes["status"] | "unknown";
  tests_passed?: number;
  tests_failed?: number;
  schema_diff_summary?: string;
  code_diff_lines?: number;
  signal: "winning" | "stalled" | "abandoned" | "running" | "unknown";
  // Structured-payload fields (FEIP-7092 slice 4). Backwards compatible:
  // older callers reading the prior shape ignore these.
  by_tag?: Partial<Record<ExperimentTag, TagOutcome>>;
  cycle_count: number;
  artifact_count: number;
  duration_ms?: number;
}

export interface TagMatrixRow {
  tag: ExperimentTag;
  /** Per-experiment cell; null when this experiment reported no data for this tag. */
  cells: Record<string, TagOutcome | null>;
}

export interface ComparisonReport {
  feature_id: string;
  generated_at: string;
  rows: ExperimentRow[];
  /**
   * Tag × experiment matrix. One row per tag any experiment reported.
   * Empty when no experiment recorded per-tag outcomes yet (early-stage
   * race or projects that don't use the tag-aware runner).
   * Consumed by the comparison-report renderer (FEIP-7208).
   */
  matrix: TagMatrixRow[];
  recommendation: "promote" | "synthesize" | "continue" | "abandon-all";
  rationale: string;
}

function readCycleCount(experimentDir: string): number {
  const timelinePath = join(experimentDir, "timeline.json");
  if (!existsSync(timelinePath)) return 0;
  try {
    const timeline = JSON.parse(readFileSync(timelinePath, "utf8")) as {
      entries?: unknown[];
    };
    return Array.isArray(timeline.entries) ? timeline.entries.length : 0;
  } catch {
    return 0;
  }
}

function readDurationMs(experimentDir: string): number | undefined {
  const path = join(experimentDir, "runtime.json");
  if (!existsSync(path)) return undefined;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as { duration_ms?: number };
    return typeof r.duration_ms === "number" ? r.duration_ms : undefined;
  } catch {
    return undefined;
  }
}

function buildMatrix(tddDir: string, featureId: string, rows: ExperimentRow[]): TagMatrixRow[] {
  void tddDir;
  void featureId;
  const tagsSeen = new Set<ExperimentTag>();
  for (const r of rows) {
    if (!r.by_tag) continue;
    for (const tag of Object.keys(r.by_tag) as ExperimentTag[]) {
      tagsSeen.add(tag);
    }
  }
  const orderedTags: ExperimentTag[] = (["api", "e2e", "infra"] as ExperimentTag[]).filter((t) => tagsSeen.has(t));
  return orderedTags.map((tag) => ({
    tag,
    cells: Object.fromEntries(rows.map((r) => [r.experiment_slug, r.by_tag?.[tag] ?? null])),
  }));
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
      by_tag: o?.by_tag,
      cycle_count: readCycleCount(exp.dir),
      artifact_count: listArtifacts(tddDir, featureId, exp.experiment_slug).length,
      duration_ms: readDurationMs(exp.dir),
    };
  });
  const matrix = buildMatrix(tddDir, featureId, rows);
  const { recommendation, rationale } = recommend(rows);
  return {
    feature_id: featureId,
    generated_at: new Date().toISOString(),
    rows,
    matrix,
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
      rationale: `1 winning experiment, no others still running – promote ${winners[0].experiment_slug}.`,
    };
  }
  if (winners.length >= 2) {
    return {
      recommendation: "synthesize",
      rationale: `${winners.length} winning experiments – Product Owner menu-picks; spec gets renegotiated.`,
    };
  }
  if (winners.length === 0 && running.length === 0 && stalled.length === rows.length && rows.length > 0) {
    return {
      recommendation: "abandon-all",
      rationale: `All ${rows.length} experiments stalled – re-run design-spec gate.`,
    };
  }
  return {
    recommendation: "continue",
    rationale: `${winners.length} winning, ${running.length} running, ${stalled.length} stalled – let cycles finish or HITL intervene.`,
  };
}
