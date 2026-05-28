import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { readMasterTestList } from "./test-list";
import type { TestList, TestListItem } from "./test-list";

export interface ExperimentStrategy {
  /** Human-readable strategy label, e.g. "postgres-arrays" or "json-blob". */
  name: string;
  /** One-sentence summary of the design choice this strategy makes. */
  rationale: string;
}

export interface BudgetProposal {
  /** Maximum concurrent experiment branches. */
  concurrent_branches: number;
  /** Wall-clock budget in minutes for the whole phase. */
  wall_clock_minutes: number;
  /** Number of Navigator+Driver agent pairs available. */
  agent_pairs: number;
}

export interface ExperimentPlan {
  feature_id: string;
  N: number;
  mode: "N=1" | "N>=2";
  strategies: ExperimentStrategy[];
  budget: BudgetProposal;
  rationale: string;
}

export interface OpinionGap {
  /** Which test item or AC surfaced the gap. */
  ref: string;
  /** Brief description of the design choice that's underspecified. */
  description: string;
}

export interface GateAnalysis {
  feature_id: string;
  opinion_gaps: OpinionGap[];
  proposed_plan: ExperimentPlan;
}

const KEYWORDS_FOR_GAPS = ["could", "either", "or", "alternatively", "consider", "decide", "evaluate", "tbd"];

export function analyzeForGate(tddDir: string, featureId: string): GateAnalysis {
  const list = readMasterTestList(tddDir, featureId);
  const gaps = detectOpinionGaps(list);
  const mode: "N=1" | "N>=2" = gaps.length >= 2 ? "N>=2" : "N=1";
  const proposed: ExperimentPlan = {
    feature_id: featureId,
    N: mode === "N=1" ? 1 : Math.min(gaps.length, 3),
    mode,
    strategies:
      mode === "N=1"
        ? [{ name: "single-experiment", rationale: "Iterative refinement; no parallel race needed." }]
        : gaps.slice(0, 3).map((g, i) => ({
            name: `strategy-${i + 1}`,
            rationale: `Address opinion gap at ${g.ref}: ${g.description}`,
          })),
    budget: {
      concurrent_branches: mode === "N=1" ? 1 : Math.min(gaps.length, 3),
      wall_clock_minutes: 180,
      agent_pairs: mode === "N=1" ? 1 : 2,
    },
    rationale:
      mode === "N=1"
        ? "Fewer than 2 opinion gaps detected – refine iteratively on a single branch."
        : `${gaps.length} opinion gaps detected – race up to 3 parallel strategies, then HITL chooses promote vs synthesize.`,
  };
  return { feature_id: featureId, opinion_gaps: gaps, proposed_plan: proposed };
}

function detectOpinionGaps(list: TestList): OpinionGap[] {
  const gaps: OpinionGap[] = [];
  for (const item of list.items) {
    const desc = item.description.toLowerCase();
    if (KEYWORDS_FOR_GAPS.some((kw) => desc.includes(kw))) {
      gaps.push({ ref: item.id, description: item.description });
    }
  }
  return gaps;
}

export function recordPlan(tddDir: string, plan: ExperimentPlan, deciderEmail?: string): void {
  mkdirSync(tddDir, { recursive: true });
  const logPath = join(tddDir, "selection-log.md");
  const ts = new Date().toISOString();
  const lines = [
    "",
    `## ${ts} – Experiment plan for ${plan.feature_id}`,
    `- **Mode:** ${plan.mode} (N=${plan.N})`,
    `- **Budget:** ${plan.budget.concurrent_branches} concurrent, ${plan.budget.wall_clock_minutes} min wall-clock, ${plan.budget.agent_pairs} agent pair(s)`,
    `- **Strategies:**`,
    ...plan.strategies.map((s) => `  - **${s.name}**: ${s.rationale}`),
    `- **Rationale:** ${plan.rationale}`,
    deciderEmail ? `- **Approved by:** ${deciderEmail}` : `- **Approved by:** pending HITL Gate 4`,
    "",
  ];
  appendFileSync(logPath, lines.join("\n"));
}

export function readPlan(tddDir: string, featureId: string): ExperimentPlan | null {
  const planPath = join(tddDir, "features", `${featureId}`, "plan.json");
  if (!existsSync(planPath)) return null;
  return JSON.parse(readFileSync(planPath, "utf8"));
}

export function writePlan(tddDir: string, plan: ExperimentPlan): void {
  // Plan persists as features/<F>/plan.json for downstream readers (orchestrator).
  const dir = join(tddDir, "features", plan.feature_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
}

// Re-export TestListItem so consumers don't need to import test-list separately for the type.
export type { TestListItem };
