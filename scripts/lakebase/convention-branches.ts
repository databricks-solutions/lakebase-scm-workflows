/**
 * Branch convention helpers — `createFeatureBranch / createTestBranch /
 * createUatBranch / createPerfBranch`.
 *
 * The PSA branching methodology (see
 * skills/lakebase-release-workflows/SKILL.md + references/branching-and-
 * release-methodology.md) defines four short-tier workflow branch types
 * that fork from `staging`:
 *
 *   prod ── staging ── feature   (active feature dev)
 *                  ├── test      (integration testing)
 *                  ├── uat       (user acceptance)
 *                  └── perf      (performance / load)
 *
 * Each is finite-lifetime — tied to a specific dev cycle, not a permanent
 * tier. So unlike `createLongRunningBranch` (which sets `no_expiry: true`
 * for the prod/staging tiers), these helpers default to a Lakebase TTL.
 *
 * Per-tier TTL defaults (override via `args.ttl`):
 *   feature: 30 days (typical feature dev cycle)
 *   test:    14 days
 *   uat:     14 days
 *   perf:     7 days
 *
 * All four fork from `staging` by default. Callers in non-staging-rooted
 * projects can override via `parentBranch`.
 */

import { createBranch as createLakebaseBranch } from "./branch-create.js";
import { LakebaseBranchInfo, BranchLookupOpts } from "./branch-utils.js";

/** Lakebase TTL format is protobuf Duration JSON: "<seconds>s". */
const DAY_SECONDS = 86_400;
const ttlDays = (days: number): string => `${days * DAY_SECONDS}s`;

/**
 * Tier defaults. Exported so tests + future tickets can introspect.
 *
 * **Workspace TTL caveat:** the PSA-convention TTLs below (30d feature,
 * 14d test/uat, 7d perf) are the documented norms but some Lakebase
 * workspaces enforce a tighter maximum-expiration policy. When a
 * workspace rejects a TTL, the substrate raises
 * {@link LakebaseBranchTtlTooLongError} with a typed, actionable message.
 * Callers can either override `ttl` per-call or set `noExpiry: true`
 * for the long-running tiers. The `history_retention_duration` field on
 * `databricks postgres get-project` is a conservative starting point.
 */
export const CONVENTION_TIER_DEFAULTS = {
  feature: { ttl: ttlDays(30), parentBranch: "staging" },
  test: { ttl: ttlDays(14), parentBranch: "staging" },
  uat: { ttl: ttlDays(14), parentBranch: "staging" },
  perf: { ttl: ttlDays(7), parentBranch: "staging" },
} as const;

export interface CreateConventionBranchArgs extends BranchLookupOpts {
  /** Target branch name. Will be sanitized to a Lakebase id. */
  branch: string;
  /** Override the parent branch. Defaults to "staging" for all four tiers. */
  parentBranch?: string;
  /** Override the TTL. Defaults to the tier's value (see CONVENTION_TIER_DEFAULTS). */
  ttl?: string;
  /**
   * Forwarded to createBranch. When the convention's default parent (e.g.
   * "staging") doesn't exist on the project, the substrate falls back to
   * the project default branch with a stderr warning. Set strictParent:
   * true to throw instead — useful for hotfix-from-production paths where
   * the lineage MUST match the convention.
   */
  strictParent?: boolean;
}

/**
 * Cut a feature-tier Lakebase branch off `staging` with a 30-day TTL.
 * Lakebase deletes the branch automatically when the TTL expires — useful
 * for feature dev cycles where the branch lives only as long as the work.
 */
export async function createFeatureBranch(
  args: CreateConventionBranchArgs,
): Promise<LakebaseBranchInfo> {
  return createLakebaseBranch({
    instance: args.instance,
    host: args.host,
    branch: args.branch,
    parentBranch: args.parentBranch ?? CONVENTION_TIER_DEFAULTS.feature.parentBranch,
    ttl: args.ttl ?? CONVENTION_TIER_DEFAULTS.feature.ttl,
    strictParent: args.strictParent,
  });
}

/** Cut a test-tier Lakebase branch off `staging` with a 14-day TTL. */
export async function createTestBranch(
  args: CreateConventionBranchArgs,
): Promise<LakebaseBranchInfo> {
  return createLakebaseBranch({
    instance: args.instance,
    host: args.host,
    branch: args.branch,
    parentBranch: args.parentBranch ?? CONVENTION_TIER_DEFAULTS.test.parentBranch,
    ttl: args.ttl ?? CONVENTION_TIER_DEFAULTS.test.ttl,
    strictParent: args.strictParent,
  });
}

/** Cut a uat-tier Lakebase branch off `staging` with a 14-day TTL. */
export async function createUatBranch(
  args: CreateConventionBranchArgs,
): Promise<LakebaseBranchInfo> {
  return createLakebaseBranch({
    instance: args.instance,
    host: args.host,
    branch: args.branch,
    parentBranch: args.parentBranch ?? CONVENTION_TIER_DEFAULTS.uat.parentBranch,
    ttl: args.ttl ?? CONVENTION_TIER_DEFAULTS.uat.ttl,
    strictParent: args.strictParent,
  });
}

/** Cut a perf-tier Lakebase branch off `staging` with a 7-day TTL. */
export async function createPerfBranch(
  args: CreateConventionBranchArgs,
): Promise<LakebaseBranchInfo> {
  return createLakebaseBranch({
    instance: args.instance,
    host: args.host,
    branch: args.branch,
    parentBranch: args.parentBranch ?? CONVENTION_TIER_DEFAULTS.perf.parentBranch,
    ttl: args.ttl ?? CONVENTION_TIER_DEFAULTS.perf.ttl,
    strictParent: args.strictParent,
  });
}
