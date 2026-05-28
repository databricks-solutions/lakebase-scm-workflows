// Centralized timeout + polling configuration for the substrate.
//
// Every CLI invocation, every wait-for-READY loop, every git operation
// previously had its own inline literal timeout scattered through the
// codebase. Drift across copies (one path bumped to 60s, another still
// 30s) is the failure mode this module exists to prevent.
//
// Each field is env-overridable so ops folks can tune behavior at
// runtime without code changes. Read once at module load to keep the
// hot path branch-free.

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface KitTimeouts {
  /** Default `databricks` CLI invocation budget (list-branches, get-branch, get-endpoint, etc.). */
  cliDefault: number;
  /** `databricks postgres create-branch` budget. Slightly higher than the default to absorb the server-side branch provisioning latency. */
  cliCreateBranch: number;
  /** `databricks postgres create-endpoint` budget. Long-running on the server side. */
  cliCreateEndpoint: number;
  /** Wait-for-READY budget for branch + endpoint state polls. */
  readyWait: number;
  /** Poll interval inside wait-for-READY loops. */
  readyPoll: number;
  /** Postgres connection-establishment timeout (used in pg.Client / pg.Pool config). */
  pgConnect: number;
  /** Postgres statement timeout (per-query budget on direct pg.Client calls). */
  pgStatement: number;
  /** Short local git ops (status / rev-parse / verify / branch -d). */
  gitDefault: number;
  /** Local git checkout (slightly higher than gitDefault to absorb working-tree work). */
  gitCheckout: number;
  /** Git operations that hit the network (ls-remote). */
  gitNetwork: number;
  /** Git push timeout. */
  gitPush: number;
  /** Long-running CLI ops outside the postgres surface (gh repo create, runner registration, etc.). */
  cliLong: number;
  /** Short-lived helper commands (which, version probes, env reads). */
  cmdShort: number;
  /** Spring Initializr metadata cache TTL. */
  initializrCacheTtl: number;
}

/**
 * Resolved at module load. Override any field via the matching
 * `LAKEBASE_KIT_TIMEOUT_*` env var, e.g.:
 *
 *   LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS=45000  # bump default CLI budget to 45s
 *   LAKEBASE_KIT_TIMEOUT_READY_WAIT_MS=300000  # 5-min branch-ready budget
 *
 * Invalid values (non-numeric, ≤ 0) fall back to the documented default.
 */
export const KIT_TIMEOUTS: KitTimeouts = {
  cliDefault: intFromEnv("LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS", 30_000),
  cliCreateBranch: intFromEnv("LAKEBASE_KIT_TIMEOUT_CLI_CREATE_BRANCH_MS", 60_000),
  cliCreateEndpoint: intFromEnv("LAKEBASE_KIT_TIMEOUT_CLI_CREATE_ENDPOINT_MS", 60_000),
  readyWait: intFromEnv("LAKEBASE_KIT_TIMEOUT_READY_WAIT_MS", 120_000),
  readyPoll: intFromEnv("LAKEBASE_KIT_TIMEOUT_READY_POLL_MS", 5_000),
  pgConnect: intFromEnv("LAKEBASE_KIT_TIMEOUT_PG_CONNECT_MS", 10_000),
  pgStatement: intFromEnv("LAKEBASE_KIT_TIMEOUT_PG_STATEMENT_MS", 15_000),
  gitDefault: intFromEnv("LAKEBASE_KIT_TIMEOUT_GIT_DEFAULT_MS", 5_000),
  gitCheckout: intFromEnv("LAKEBASE_KIT_TIMEOUT_GIT_CHECKOUT_MS", 10_000),
  gitNetwork: intFromEnv("LAKEBASE_KIT_TIMEOUT_GIT_NETWORK_MS", 15_000),
  gitPush: intFromEnv("LAKEBASE_KIT_TIMEOUT_GIT_PUSH_MS", 30_000),
  cliLong: intFromEnv("LAKEBASE_KIT_TIMEOUT_CLI_LONG_MS", 60_000),
  cmdShort: intFromEnv("LAKEBASE_KIT_TIMEOUT_CMD_SHORT_MS", 5_000),
  initializrCacheTtl: intFromEnv("LAKEBASE_KIT_INITIALIZR_CACHE_TTL_MS", 10 * 60 * 1000),
};
