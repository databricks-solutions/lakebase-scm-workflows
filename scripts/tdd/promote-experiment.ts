import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { listExperiments, readOutcomes, writeOutcomes } from "./experiment";
import { readFeature, writeFeature } from "./spec-sync";

export interface PromoteArgs {
  tddDir: string;
  featureId: string;
  winnerSlug: string;
  /** Set to true to record the HITL approval. Refuses to run without it. */
  hitlApproved: boolean;
  approverEmail?: string;
}

export interface PromoteResult {
  winner_slug: string;
  archived_slugs: string[];
  feature_status: string;
}

/**
 * Promote one experiment as the feature's chosen outcome.
 *
 * Side effects:
 *  - Updates winner outcomes: status="succeeded".
 *  - Updates loser outcomes: status="abandoned".
 *  - Moves loser dirs under .tdd/experiments/<F>/_archive/.
 *  - Transitions feature.json status to "ready-for-review".
 *  - Appends a record to .tdd/selection-log.md.
 *
 * This is HITL-gated: callers must set hitlApproved=true. The function refuses
 * to run otherwise so the orchestrator cannot promote without a recorded
 * human decision.
 */
export function promoteExperiment(args: PromoteArgs): PromoteResult {
  if (!args.hitlApproved) {
    throw new Error("promoteExperiment requires hitlApproved: true (HITL Gate)");
  }
  const { tddDir, featureId, winnerSlug, approverEmail } = args;
  const experiments = listExperiments(tddDir, featureId);
  const winner = experiments.find((e) => e.experiment_slug === winnerSlug);
  if (!winner) {
    throw new Error(`winner ${winnerSlug} not found among experiments for ${featureId}`);
  }
  const losers = experiments.filter((e) => e.experiment_slug !== winnerSlug);

  // Update outcomes
  const winnerOutcome = readOutcomes(tddDir, featureId, winnerSlug);
  writeOutcomes(tddDir, featureId, winnerSlug, { ...(winnerOutcome ?? {}), status: "succeeded" });

  const archiveDir = join(tddDir, "experiments", featureId, "_archive");
  mkdirSync(archiveDir, { recursive: true });
  for (const loser of losers) {
    const prior = readOutcomes(tddDir, featureId, loser.experiment_slug);
    writeOutcomes(tddDir, featureId, loser.experiment_slug, {
      ...(prior ?? {}),
      status: "abandoned",
    });
    const dest = join(archiveDir, loser.experiment_slug);
    if (existsSync(dest)) {
      // Already archived; skip rename to avoid collision.
      continue;
    }
    renameSync(loser.dir, dest);
  }

  // Feature → ready-for-review
  try {
    const feature = readFeature(tddDir, featureId);
    feature.status = "ready-for-review";
    writeFeature(tddDir, feature);
  } catch {
    // No feature.json – caller's responsibility. Don't block promotion.
  }

  // Append to selection log
  const logPath = join(tddDir, "selection-log.md");
  const ts = new Date().toISOString();
  const lines = [
    "",
    `## ${ts} – Promote ${winnerSlug} for ${featureId}`,
    `- **Winner:** ${winnerSlug} (branch ${winner.branch_id})`,
    losers.length > 0
      ? `- **Archived:** ${losers.map((l) => l.experiment_slug).join(", ")}`
      : `- **Archived:** none (no parallel experiments)`,
    `- **Approved by:** ${approverEmail ?? "HITL (no email recorded)"}`,
    "",
  ];
  if (existsSync(logPath)) {
    writeFileSync(logPath, readFileSync(logPath, "utf8") + lines.join("\n"));
  } else {
    writeFileSync(logPath, lines.join("\n"));
  }

  return {
    winner_slug: winnerSlug,
    archived_slugs: losers.map((l) => l.experiment_slug),
    feature_status: "ready-for-review",
  };
}
