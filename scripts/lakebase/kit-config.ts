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
  // ── PSA convention branch TTLs (ms) ────────────────────────────────
  //
  // The four short-lived tier flavors (feature/test/uat/perf) each have
  // a documented default expiry. Workspaces with a tighter
  // maximum-expiration policy can lower these via the matching env var
  // – substrate will format `<seconds>s` for the Lakebase API at the
  // call site. The defaults below match the PSA convention:
  //   feature: 30d, test: 14d, uat: 14d, perf: 7d
  /** Default TTL for feature-tier branches (createFeatureBranch / cutExperiment). */
  featureBranchTtlMs: number;
  /** Default TTL for test-tier branches (createTestBranch). */
  testBranchTtlMs: number;
  /** Default TTL for uat-tier branches (createUatBranch). */
  uatBranchTtlMs: number;
  /** Default TTL for perf-tier branches (createPerfBranch). */
  perfBranchTtlMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

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
  featureBranchTtlMs: intFromEnv("LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS", 30 * DAY_MS),
  testBranchTtlMs: intFromEnv("LAKEBASE_KIT_TEST_BRANCH_TTL_MS", 14 * DAY_MS),
  uatBranchTtlMs: intFromEnv("LAKEBASE_KIT_UAT_BRANCH_TTL_MS", 14 * DAY_MS),
  perfBranchTtlMs: intFromEnv("LAKEBASE_KIT_PERF_BRANCH_TTL_MS", 7 * DAY_MS),
};

/**
 * Format an ms-typed TTL as the Lakebase API's protobuf Duration JSON
 * encoding (`<seconds>s`). Used by CONVENTION_TIER_DEFAULTS when
 * formatting branch TTLs for create-branch specs.
 */
export function formatLakebaseTtl(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

// ── Package registry URLs ──────────────────────────────────────────────
//
// Public package-registry endpoints the kit hits during scaffolding +
// dev-environment provisioning. Each defaults to the mainline registry;
// override via the matching env var when running against a proxied or
// air-gapped environment (e.g. Databricks-internal proxies for Maven
// Central / npm / PyPI – see internal docs for the setup).

export interface KitRegistries {
  /**
   * Maven Central root. Used to download the Flyway CLI in
   * scripts/run-live-tests.sh and for any future Maven-resolved
   * artifact pulls.
   *
   * Default: https://repo1.maven.org/maven2  (mainline Maven Central)
   * Override: `LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL=https://your-proxy/maven2`
   */
  mavenCentral: string;
  /**
   * Spring Initializr base URL. Used by spring-initializr.ts to
   * fetch starter projects + metadata.
   *
   * Default: https://start.spring.io  (mainline Spring Initializr)
   * Override: `LAKEBASE_KIT_REGISTRY_SPRING_INITIALIZR=https://your-mirror`
   */
  springInitializr: string;
}

function urlFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  // Trim trailing slashes so callers can safely concat `/path` segments.
  return raw.replace(/\/+$/, "");
}

/**
 * Resolved at module load. Override any field via the matching
 * `LAKEBASE_KIT_REGISTRY_*` env var.
 */
export const KIT_REGISTRIES: KitRegistries = {
  mavenCentral: urlFromEnv("LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL", "https://repo1.maven.org/maven2"),
  springInitializr: urlFromEnv("LAKEBASE_KIT_REGISTRY_SPRING_INITIALIZR", "https://start.spring.io"),
};
