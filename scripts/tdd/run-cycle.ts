import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConnection } from "../lakebase/get-connection";
import type { DsnResult } from "../lakebase/get-connection";

export type CycleStage = "PLAN" | "RED" | "GREEN" | "REFACTOR";
export type CycleVerdict = "passed" | "failed" | "skipped";

export interface CycleArtifact {
  cycle_id: string;
  feature_id: string;
  story_id: string;
  ac_id: string;
  test_id: string;
  test_description: string;
  experiment_slug?: string;
  branch_id?: string;
  navigator_plan?: string;
  navigator_verdict?: CycleVerdict;
  driver_changes?: string;
  refactor_notes?: string;
  red_at?: string;
  green_at?: string;
  refactored_at?: string;
  smell_flags?: string[];
}

export interface CycleScope {
  tddDir: string;
  feature_id: string;
  story_id: string;
  ac_id: string;
  experiment_slug?: string;
  branch_id?: string;
}

function cyclesDir(scope: CycleScope): string {
  return join(scope.tddDir, "cycles", scope.feature_id, scope.story_id, scope.ac_id);
}

export function nextCycleId(scope: CycleScope): string {
  const dir = cyclesDir(scope);
  if (!existsSync(dir)) return "cycle-001";
  const ids = readdirSync(dir)
    .filter((f) => /^cycle-\d+\.json$/.test(f))
    .map((f) => parseInt(f.match(/cycle-(\d+)/)![1], 10))
    .sort((a, b) => a - b);
  const next = (ids.at(-1) ?? 0) + 1;
  return `cycle-${String(next).padStart(3, "0")}`;
}

export function writeCycleArtifact(scope: CycleScope, artifact: CycleArtifact): string {
  const dir = cyclesDir(scope);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${artifact.cycle_id}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  return file;
}

export function readCycleArtifact(scope: CycleScope, cycleId: string): CycleArtifact | null {
  const file = join(cyclesDir(scope), `${cycleId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function listCycles(scope: CycleScope): CycleArtifact[] {
  const dir = cyclesDir(scope);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

export interface OpenBranchDsnArgs {
  instance: string;
  branch_id: string;
}

/**
 * Open a DSN against the experiment's Lakebase branch so the test runner
 * (Vitest / Jest / Pytest / Flyway / etc.) can connect to a real per-branch DB.
 * Returned DSN strings are scoped to the experiment branch – not staging, not prod.
 */
export async function openBranchDsn(args: OpenBranchDsnArgs): Promise<DsnResult> {
  return getConnection({
    instance: args.instance,
    branch: args.branch_id,
    output: "dsn",
  });
}

export interface BeginCycleArgs extends CycleScope {
  test_id: string;
  test_description: string;
  navigator_plan?: string;
}

export function beginCycle(args: BeginCycleArgs): CycleArtifact {
  const cycle_id = nextCycleId(args);
  const artifact: CycleArtifact = {
    cycle_id,
    feature_id: args.feature_id,
    story_id: args.story_id,
    ac_id: args.ac_id,
    test_id: args.test_id,
    test_description: args.test_description,
    experiment_slug: args.experiment_slug,
    branch_id: args.branch_id,
    navigator_plan: args.navigator_plan,
    red_at: new Date().toISOString(),
  };
  writeCycleArtifact(args, artifact);
  return artifact;
}

export function markGreen(
  scope: CycleScope,
  cycleId: string,
  driverChanges?: string
): CycleArtifact {
  const a = readCycleArtifact(scope, cycleId);
  if (!a) throw new Error(`cycle ${cycleId} not found`);
  a.green_at = new Date().toISOString();
  a.driver_changes = driverChanges;
  a.navigator_verdict = "passed";
  writeCycleArtifact(scope, a);
  return a;
}

export function markRefactored(scope: CycleScope, cycleId: string, refactorNotes?: string): CycleArtifact {
  const a = readCycleArtifact(scope, cycleId);
  if (!a) throw new Error(`cycle ${cycleId} not found`);
  a.refactored_at = new Date().toISOString();
  a.refactor_notes = refactorNotes;
  writeCycleArtifact(scope, a);
  return a;
}

export function flagSmells(scope: CycleScope, cycleId: string, smells: string[]): CycleArtifact {
  const a = readCycleArtifact(scope, cycleId);
  if (!a) throw new Error(`cycle ${cycleId} not found`);
  a.smell_flags = [...new Set([...(a.smell_flags ?? []), ...smells])];
  writeCycleArtifact(scope, a);
  return a;
}
