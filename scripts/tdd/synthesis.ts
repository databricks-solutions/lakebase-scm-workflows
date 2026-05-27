import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { join } from "path";
import { listExperiments } from "./experiment";
import { cutExperiment } from "./experiment";
import type { ExperimentRecord } from "./experiment";
import type { BranchLookupOpts } from "./../lakebase/branch-utils";

export interface SynthesisPick {
  /** Experiment slug whose capability is being pulled in. */
  source_slug: string;
  /** Which capability / behavior is being carried over. Free-text PO note. */
  capability: string;
}

export interface SynthesizeArgs extends BranchLookupOpts {
  tddDir: string;
  featureId: string;
  picks: SynthesisPick[];
  /** Slug for the new synthesized experiment branch. */
  synthesizedSlug: string;
  /** Branch name for the synthesized cycle. */
  branch: string;
  /** Parent for the synthesized branch. Defaults to staging. */
  parentBranch?: string;
  /** HITL approval gate. */
  hitlApproved: boolean;
  approverEmail?: string;
}

export interface SynthesizeResult {
  synthesis_dir: string;
  synthesized_spec_dir: string;
  fresh_experiment: ExperimentRecord;
}

/**
 * Menu-pick across N>=2 experiments. Produces a synthesized spec under
 * synthesis/<F>/synthesized-spec/ and cuts a fresh experiment branch for the
 * renegotiated cycle.
 *
 * HITL-gated: refuses to run without hitlApproved=true.
 */
export async function synthesizeExperiments(args: SynthesizeArgs): Promise<SynthesizeResult> {
  if (!args.hitlApproved) {
    throw new Error("synthesizeExperiments requires hitlApproved: true (HITL Gate)");
  }
  const { tddDir, featureId, picks, synthesizedSlug, branch, parentBranch, approverEmail, ...lookup } = args;

  if (picks.length < 2) {
    throw new Error(`synthesis requires picks from at least 2 experiments (got ${picks.length})`);
  }
  const experiments = listExperiments(tddDir, featureId);
  for (const pick of picks) {
    if (!experiments.find((e) => e.experiment_slug === pick.source_slug)) {
      throw new Error(`pick source ${pick.source_slug} is not an experiment of ${featureId}`);
    }
  }

  // Synthesis decision record
  const ts = new Date().toISOString();
  const synthesisDir = join(tddDir, "synthesis", featureId);
  mkdirSync(synthesisDir, { recursive: true });
  const dateSlug = ts.slice(0, 10);
  const decisionFile = join(synthesisDir, `synthesis-${dateSlug}.md`);
  const decisionBody = [
    `# Synthesis decision for ${featureId} (${ts})`,
    "",
    `**Approved by:** ${approverEmail ?? "HITL (no email recorded)"}`,
    `**Synthesized experiment:** ${synthesizedSlug} (branch \`${branch}\`)`,
    "",
    "## Menu picks",
    "",
    ...picks.map((p) => `- **${p.source_slug}** → ${p.capability}`),
    "",
    "## Integration rules",
    "",
    "Picks are combined as additive contributions. Conflicts between picks are resolved in the new cycle's RED tests, not in the spec.",
    "",
  ].join("\n");
  writeFileSync(decisionFile, decisionBody);

  // Synthesized spec subtree — copy the most-recent winning spec (or the first pick) as a starting point
  const synthesizedSpecDir = join(synthesisDir, "synthesized-spec");
  mkdirSync(synthesizedSpecDir, { recursive: true });
  const seedFeatureDir = locateFeatureDir(tddDir, featureId);
  if (seedFeatureDir && existsSync(seedFeatureDir)) {
    cpSync(seedFeatureDir, join(synthesizedSpecDir, "feature"), { recursive: true });
  }
  writeFileSync(
    join(synthesizedSpecDir, "README.md"),
    `# Synthesized spec for ${featureId}\n\nSeeded from \`features/${featureId}/\`. Renegotiate ACs + test list per the synthesis-${dateSlug}.md menu picks before starting the fresh cycle.\n`
  );

  // Selection log
  const logPath = join(tddDir, "selection-log.md");
  const logLines = [
    "",
    `## ${ts} — Synthesize ${featureId}`,
    `- **Synthesized experiment:** ${synthesizedSlug}`,
    `- **Picks:**`,
    ...picks.map((p) => `  - ${p.source_slug}: ${p.capability}`),
    `- **Approved by:** ${approverEmail ?? "HITL (no email recorded)"}`,
    "",
  ];
  if (existsSync(logPath)) {
    writeFileSync(logPath, readFileSync(logPath, "utf8") + logLines.join("\n"));
  } else {
    writeFileSync(logPath, logLines.join("\n"));
  }

  // Cut the fresh experiment branch
  const fresh = await cutExperiment({
    ...lookup,
    tddDir,
    featureId,
    experimentSlug: synthesizedSlug,
    branch,
    parentBranch,
    notes: `# ${synthesizedSlug}\n\nSynthesized from menu picks across ${picks.length} experiments. See ${decisionFile}.\n`,
  });

  return {
    synthesis_dir: synthesisDir,
    synthesized_spec_dir: synthesizedSpecDir,
    fresh_experiment: fresh,
  };
}

function locateFeatureDir(tddDir: string, featureId: string): string | null {
  const featuresDir = join(tddDir, "features");
  if (!existsSync(featuresDir)) return null;
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const candidate = readdirSync(featuresDir).find((d: string) => d.startsWith(featureId));
  if (!candidate) return null;
  const full = join(featuresDir, candidate);
  return statSync(full).isDirectory() ? full : null;
}
