import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createFeatureBranch } from "../lakebase/convention-branches";
import { deleteBranch } from "../lakebase/branch-delete";
import type { BranchLookupOpts, LakebaseBranchInfo } from "../lakebase/branch-utils";

function branchIdOf(info: LakebaseBranchInfo): string {
  const leaf = info.name.split("/").pop();
  if (!leaf) throw new Error(`could not derive branch_id from ${info.name}`);
  return leaf;
}

export interface ExperimentOutcomes {
  tests_passed?: number;
  tests_failed?: number;
  schema_diff_summary?: string;
  code_diff_lines?: number;
  status: "running" | "succeeded" | "failed" | "abandoned";
}

export interface CutExperimentArgs extends BranchLookupOpts {
  tddDir: string;
  featureId: string;
  experimentSlug: string;
  branch: string;
  parentBranch?: string;
  ttl?: string;
  notes?: string;
}

export interface ExperimentRecord {
  feature_id: string;
  experiment_slug: string;
  branch_id: string;
  created_at: string;
  dir: string;
}

export async function cutExperiment(args: CutExperimentArgs): Promise<ExperimentRecord> {
  const { tddDir, featureId, experimentSlug, branch, parentBranch, ttl, notes, ...lookup } = args;
  const branchInfo = await createFeatureBranch({ ...lookup, branch, parentBranch, ttl });
  const branchId = branchIdOf(branchInfo);

  const dir = join(tddDir, "experiments", featureId, experimentSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch.txt"), branchId);
  writeFileSync(
    join(dir, "notes.md"),
    notes ?? `# ${experimentSlug}\n\nExperiment cut from \`${parentBranch ?? "staging"}\`. Strategy + learning notes go here.\n`
  );
  const outcomes: ExperimentOutcomes = { status: "running" };
  writeFileSync(join(dir, "outcomes.json"), JSON.stringify(outcomes, null, 2) + "\n");
  writeFileSync(
    join(dir, "timeline.json"),
    JSON.stringify(
      { entries: [{ ts: new Date().toISOString(), kind: "cut", branch: branchId }] },
      null,
      2
    ) + "\n"
  );

  return {
    feature_id: featureId,
    experiment_slug: experimentSlug,
    branch_id: branchId,
    created_at: new Date().toISOString(),
    dir,
  };
}

export function listExperiments(tddDir: string, featureId: string): ExperimentRecord[] {
  const root = join(tddDir, "experiments", featureId);
  if (!existsSync(root)) return [];
  const out: ExperimentRecord[] = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    if (!statSync(dir).isDirectory()) continue;
    const branchFile = join(dir, "branch.txt");
    if (!existsSync(branchFile)) continue;
    out.push({
      feature_id: featureId,
      experiment_slug: slug,
      branch_id: readFileSync(branchFile, "utf8").trim(),
      created_at: statSync(branchFile).birthtime.toISOString(),
      dir,
    });
  }
  return out;
}

export function readOutcomes(tddDir: string, featureId: string, slug: string): ExperimentOutcomes | null {
  const file = join(tddDir, "experiments", featureId, slug, "outcomes.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeOutcomes(
  tddDir: string,
  featureId: string,
  slug: string,
  outcomes: ExperimentOutcomes
): void {
  const file = join(tddDir, "experiments", featureId, slug, "outcomes.json");
  writeFileSync(file, JSON.stringify(outcomes, null, 2) + "\n");
}

export interface DeleteExperimentArgs extends BranchLookupOpts {
  tddDir: string;
  featureId: string;
  experimentSlug: string;
  /** Delete the Lakebase branch as well. Default false; HITL-gated. */
  deleteBranchToo?: boolean;
}

export async function deleteExperiment(args: DeleteExperimentArgs): Promise<void> {
  const { tddDir, featureId, experimentSlug, deleteBranchToo, ...lookup } = args;
  const dir = join(tddDir, "experiments", featureId, experimentSlug);
  if (!existsSync(dir)) {
    throw new Error(`experiment ${featureId}/${experimentSlug} not found at ${dir}`);
  }
  if (deleteBranchToo) {
    const branchId = readFileSync(join(dir, "branch.txt"), "utf8").trim();
    await deleteBranch({ ...lookup, branch: branchId });
  }
  // The on-disk record is preserved by default so the experiment's notes + outcomes
  // remain available after the branch goes away.
}
