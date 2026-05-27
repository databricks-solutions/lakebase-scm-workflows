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

export interface CutSpikeArgs extends BranchLookupOpts {
  tddDir: string;
  spikeSlug: string;
  branch: string;
  parentBranch?: string;
  ttl?: string;
  notes?: string;
}

export interface SpikeRecord {
  spike_slug: string;
  branch_id: string;
  created_at: string;
  dir: string;
}

export async function cutSpike(args: CutSpikeArgs): Promise<SpikeRecord> {
  const { tddDir, spikeSlug, branch, parentBranch, ttl, notes, ...lookup } = args;
  const branchInfo = await createFeatureBranch({ ...lookup, branch, parentBranch, ttl });
  const branchId = branchIdOf(branchInfo);

  const dir = join(tddDir, "spikes", spikeSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch.txt"), branchId);
  writeFileSync(
    join(dir, "notes.md"),
    notes ??
      `# ${spikeSlug}\n\nThrowaway spike. Code is **not** promoted as-is. Capture learning before deleting the branch.\n`
  );
  return {
    spike_slug: spikeSlug,
    branch_id: branchId,
    created_at: new Date().toISOString(),
    dir,
  };
}

export function listSpikes(tddDir: string): SpikeRecord[] {
  const root = join(tddDir, "spikes");
  if (!existsSync(root)) return [];
  const out: SpikeRecord[] = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    if (!statSync(dir).isDirectory()) continue;
    const branchFile = join(dir, "branch.txt");
    if (!existsSync(branchFile)) continue;
    out.push({
      spike_slug: slug,
      branch_id: readFileSync(branchFile, "utf8").trim(),
      created_at: statSync(branchFile).birthtime.toISOString(),
      dir,
    });
  }
  return out;
}

export interface DeleteSpikeArgs extends BranchLookupOpts {
  tddDir: string;
  spikeSlug: string;
  /** Delete the Lakebase branch as well. Default true for spikes (they're throwaway by definition). */
  deleteBranchToo?: boolean;
}

export async function deleteSpike(args: DeleteSpikeArgs): Promise<void> {
  const { tddDir, spikeSlug, deleteBranchToo = true, ...lookup } = args;
  const dir = join(tddDir, "spikes", spikeSlug);
  if (!existsSync(dir)) throw new Error(`spike ${spikeSlug} not found at ${dir}`);
  if (deleteBranchToo) {
    const branchId = readFileSync(join(dir, "branch.txt"), "utf8").trim();
    await deleteBranch({ ...lookup, branch: branchId });
  }
  // Notes preserved on disk so the learning survives the branch teardown.
}
