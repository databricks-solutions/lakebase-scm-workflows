import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { readMasterTestList, type TestListItem } from "./test-list";
import { readPlan, type ExperimentPlan } from "./design-spec-gate";
import {
  listExperiments,
  readOutcomes,
  type ExperimentOutcomes,
} from "./experiment";
import { readSmellsLog, type SmellsLog } from "./smells";

export type TestListStatus = TestListItem["status"];

export interface TestListSummary {
  total: number;
  by_status: Record<TestListStatus, number>;
  completion_pct: number;
}

export interface ExperimentStatusEntry {
  slug: string;
  branch_id: string;
  status: ExperimentOutcomes["status"] | null;
  tests_passed: number | null;
  tests_failed: number | null;
  schema_diff_summary: string | null;
  cycle_count: number;
}

export interface SelectionLogEntry {
  timestamp: string;
  title: string;
}

export interface WorkflowPointer {
  feature_id: string | null;
  story_id: string | null;
  ac_id: string | null;
  cycle_id: string | null;
  experiment_id: string | null;
}

export interface FeatureStatusSnapshot {
  feature_id: string;
  current_workflow_phase: string | null;
  current_workflow_pointer: WorkflowPointer | null;
  plan: ExperimentPlan | null;
  test_list: TestListSummary | null;
  experiments: ExperimentStatusEntry[];
  selection_log_recent: SelectionLogEntry[];
  open_smells: SmellsLog["detected"];
}

const MAX_RECENT_LOG_ENTRIES = 5;

function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function timelineCycleCount(experimentDir: string): number {
  const timeline = readJsonIfExists<{ entries?: Array<{ kind?: string }> }>(
    join(experimentDir, "timeline.json")
  );
  return timeline?.entries?.length ?? 0;
}

function summarizeTestList(
  tddDir: string,
  featureId: string
): TestListSummary | null {
  try {
    const list = readMasterTestList(tddDir, featureId);
    const counters: Record<TestListStatus, number> = {
      pending: 0,
      red: 0,
      green: 0,
      refactored: 0,
      skipped: 0,
    };
    for (const item of list.items) counters[item.status]++;
    const total = list.items.length;
    const done = counters.green + counters.refactored;
    return {
      total,
      by_status: counters,
      completion_pct: total === 0 ? 0 : Math.round((done / total) * 100),
    };
  } catch {
    return null;
  }
}

function readSelectionLogRecent(
  tddDir: string,
  limit: number
): SelectionLogEntry[] {
  const path = join(tddDir, "selection-log.md");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  // selection-log entries start with `## <ISO-timestamp> — <title>`
  const entries: SelectionLogEntry[] = [];
  const headingRe = /^##\s+(\S+T\S+?)\s+—\s+(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text)) !== null) {
    entries.push({ timestamp: match[1], title: match[2].trim() });
  }
  return entries.slice(-limit);
}

function readWorkflowState(tddDir: string): {
  phase: string | null;
  pointer: WorkflowPointer | null;
} {
  const state = readJsonIfExists<{
    phase?: string;
    feature_id?: string | null;
    story_id?: string | null;
    ac_id?: string | null;
    cycle_id?: string | null;
    experiment_id?: string | null;
  }>(join(tddDir, "workflow-state.json"));
  if (!state) return { phase: null, pointer: null };
  return {
    phase: state.phase ?? null,
    pointer: {
      feature_id: state.feature_id ?? null,
      story_id: state.story_id ?? null,
      ac_id: state.ac_id ?? null,
      cycle_id: state.cycle_id ?? null,
      experiment_id: state.experiment_id ?? null,
    },
  };
}

export function getFeatureStatus(
  tddDir: string,
  featureId: string
): FeatureStatusSnapshot {
  const plan = readPlan(tddDir, featureId);
  const experimentRecords = listExperiments(tddDir, featureId);

  const experiments: ExperimentStatusEntry[] = experimentRecords.map((rec) => {
    const outcomes = readOutcomes(tddDir, featureId, rec.experiment_slug);
    return {
      slug: rec.experiment_slug,
      branch_id: rec.branch_id,
      status: outcomes?.status ?? null,
      tests_passed: outcomes?.tests_passed ?? null,
      tests_failed: outcomes?.tests_failed ?? null,
      schema_diff_summary: outcomes?.schema_diff_summary ?? null,
      cycle_count: timelineCycleCount(rec.dir),
    };
  });

  let smells: SmellsLog["detected"] = [];
  try {
    smells = readSmellsLog(tddDir).detected.filter((d) => !d.resolution);
  } catch {
    smells = [];
  }

  const { phase, pointer } = readWorkflowState(tddDir);

  return {
    feature_id: featureId,
    current_workflow_phase: phase,
    current_workflow_pointer: pointer,
    plan,
    test_list: summarizeTestList(tddDir, featureId),
    experiments,
    selection_log_recent: readSelectionLogRecent(tddDir, MAX_RECENT_LOG_ENTRIES),
    open_smells: smells,
  };
}

function formatTestPassRatio(exp: ExperimentStatusEntry): string {
  if (exp.tests_passed === null && exp.tests_failed === null) {
    return "tests=n/a";
  }
  const passed = exp.tests_passed ?? 0;
  const failed = exp.tests_failed ?? 0;
  return `tests=${passed}/${passed + failed} pass`;
}

export function renderFeatureStatus(snapshot: FeatureStatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`Feature: ${snapshot.feature_id}`);

  if (snapshot.current_workflow_phase) {
    const ptr = snapshot.current_workflow_pointer;
    const focus =
      ptr?.feature_id === snapshot.feature_id
        ? " (active workflow)"
        : ptr?.feature_id
          ? ` (active workflow on ${ptr.feature_id})`
          : "";
    lines.push(`  Phase: ${snapshot.current_workflow_phase}${focus}`);
  } else {
    lines.push(`  Phase: unknown (no workflow-state.json)`);
  }

  if (snapshot.plan) {
    const plural = snapshot.plan.strategies.length === 1 ? "y" : "ies";
    lines.push(
      `  Plan: ${snapshot.plan.mode} (N=${snapshot.plan.N}, ${snapshot.plan.strategies.length} strateg${plural})`
    );
  } else {
    lines.push(`  Plan: not yet approved (design-spec gate pending)`);
  }

  if (snapshot.test_list) {
    const s = snapshot.test_list;
    const breakdown = (Object.entries(s.by_status) as [TestListStatus, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(" ");
    const done = s.by_status.green + s.by_status.refactored;
    lines.push(
      `  Test list: ${done}/${s.total} (${s.completion_pct}%)${breakdown ? `  [${breakdown}]` : ""}`
    );
  } else {
    lines.push(`  Test list: not yet written`);
  }

  lines.push(``);
  if (snapshot.experiments.length > 0) {
    lines.push(`Experiments (${snapshot.experiments.length}):`);
    for (const exp of snapshot.experiments) {
      lines.push(
        `  ${exp.slug.padEnd(28)} branch=${exp.branch_id.padEnd(22)} status=${(exp.status ?? "unknown").padEnd(11)} ${formatTestPassRatio(exp)}  cycles=${exp.cycle_count}`
      );
    }
  } else {
    lines.push(`Experiments: none cut yet`);
  }

  if (snapshot.selection_log_recent.length > 0) {
    lines.push(``);
    lines.push(`Recent decisions (${snapshot.selection_log_recent.length}):`);
    for (const entry of snapshot.selection_log_recent) {
      lines.push(`  ${entry.timestamp} — ${entry.title}`);
    }
  }

  lines.push(``);
  if (snapshot.open_smells.length > 0) {
    lines.push(`Open smells (${snapshot.open_smells.length}):`);
    for (const hit of snapshot.open_smells) {
      lines.push(`  ${hit.smell} — ${hit.detail}`);
    }
  } else {
    lines.push(`Open smells: none`);
  }

  return lines.join("\n") + "\n";
}
