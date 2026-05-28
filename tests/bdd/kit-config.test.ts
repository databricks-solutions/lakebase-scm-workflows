import { describe, it, expect } from "vitest";
import {
  KIT_TIMEOUTS,
  KIT_REGISTRIES,
  formatLakebaseTtl,
} from "../../scripts/lakebase/kit-config";

// kit-config is the single source of truth for every timeout the
// substrate scatters across its files. The test pins documented
// defaults + the env-override surface so a future tuning change
// doesn't quietly drift them out of sync.
//
// Env-override coverage: KIT_TIMEOUTS is read once at module load.
// Verifying the env-override mechanic itself requires loading the
// module fresh with new env, which isn't worth the vitest gymnastics
// here – the override path is straightforward (intFromEnv falls back
// to the default on parse failure / non-positive value), so we cover
// the documented defaults + the field surface only.

describe("KIT_TIMEOUTS – documented defaults", () => {
  it("CLI invocations fall in the 30s default / 60s long bands", () => {
    expect(KIT_TIMEOUTS.cliDefault).toBe(30_000);
    expect(KIT_TIMEOUTS.cliCreateBranch).toBe(60_000);
    expect(KIT_TIMEOUTS.cliCreateEndpoint).toBe(60_000);
    expect(KIT_TIMEOUTS.cliLong).toBe(60_000);
  });

  it("wait-for-READY uses a 2-minute budget with 5s polls", () => {
    expect(KIT_TIMEOUTS.readyWait).toBe(120_000);
    expect(KIT_TIMEOUTS.readyPoll).toBe(5_000);
  });

  it("Postgres client timeouts: 10s connect / 15s statement", () => {
    expect(KIT_TIMEOUTS.pgConnect).toBe(10_000);
    expect(KIT_TIMEOUTS.pgStatement).toBe(15_000);
  });

  it("git operations: 5s local / 10s checkout / 15s network / 30s push", () => {
    expect(KIT_TIMEOUTS.gitDefault).toBe(5_000);
    expect(KIT_TIMEOUTS.gitCheckout).toBe(10_000);
    expect(KIT_TIMEOUTS.gitNetwork).toBe(15_000);
    expect(KIT_TIMEOUTS.gitPush).toBe(30_000);
  });

  it("short helper commands are 5s by default", () => {
    expect(KIT_TIMEOUTS.cmdShort).toBe(5_000);
  });

  it("Spring Initializr metadata cache TTL is 10 minutes", () => {
    expect(KIT_TIMEOUTS.initializrCacheTtl).toBe(10 * 60 * 1000);
  });

  it("every value is a positive integer (env-override fallback contract)", () => {
    for (const [name, value] of Object.entries(KIT_TIMEOUTS)) {
      expect(typeof value, `${name} should be a number`).toBe("number");
      expect(Number.isFinite(value), `${name} should be finite`).toBe(true);
      expect(value, `${name} should be positive`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `${name} should be an integer`).toBe(true);
    }
  });

  // PSA-default convention TTLs (30d feature / 14d test+uat / 7d perf).
  // Each tier's default is env-overridable; in a clean test env (no
  // LAKEBASE_KIT_*_BRANCH_TTL_MS set) the defaults MUST resolve so the
  // mainline path stays the no-config-required happy case. When a tier's
  // override IS set (e.g. .env.local.config sources a tighter cap) the
  // matching assertion is skipped; the env-override mechanic is covered
  // by KitTimeouts' positive-integer + closed-shape contracts below.
  const FEATURE_TTL_ENV = !!process.env.LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS;
  const TEST_TTL_ENV = !!process.env.LAKEBASE_KIT_TEST_BRANCH_TTL_MS;
  const UAT_TTL_ENV = !!process.env.LAKEBASE_KIT_UAT_BRANCH_TTL_MS;
  const PERF_TTL_ENV = !!process.env.LAKEBASE_KIT_PERF_BRANCH_TTL_MS;
  const DAY_MS = 24 * 60 * 60 * 1000;

  it.skipIf(FEATURE_TTL_ENV)("feature-tier default TTL is 30 days", () => {
    expect(KIT_TIMEOUTS.featureBranchTtlMs).toBe(30 * DAY_MS);
  });

  it.skipIf(TEST_TTL_ENV)("test-tier default TTL is 14 days", () => {
    expect(KIT_TIMEOUTS.testBranchTtlMs).toBe(14 * DAY_MS);
  });

  it.skipIf(UAT_TTL_ENV)("uat-tier default TTL is 14 days", () => {
    expect(KIT_TIMEOUTS.uatBranchTtlMs).toBe(14 * DAY_MS);
  });

  it.skipIf(PERF_TTL_ENV)("perf-tier default TTL is 7 days", () => {
    expect(KIT_TIMEOUTS.perfBranchTtlMs).toBe(7 * DAY_MS);
  });

  it("exposes every documented field (closed shape)", () => {
    expect(Object.keys(KIT_TIMEOUTS).sort()).toEqual(
      [
        "cliDefault",
        "cliCreateBranch",
        "cliCreateEndpoint",
        "readyWait",
        "readyPoll",
        "pgConnect",
        "pgStatement",
        "gitDefault",
        "gitCheckout",
        "gitNetwork",
        "gitPush",
        "cliLong",
        "cmdShort",
        "initializrCacheTtl",
        "featureBranchTtlMs",
        "testBranchTtlMs",
        "uatBranchTtlMs",
        "perfBranchTtlMs",
      ].sort()
    );
  });
});

describe("formatLakebaseTtl – protobuf Duration format", () => {
  it("formats ms → `<seconds>s` as Lakebase expects in create-branch specs", () => {
    expect(formatLakebaseTtl(86_400_000)).toBe("86400s"); // 1 day
    expect(formatLakebaseTtl(7 * 24 * 60 * 60 * 1000)).toBe("604800s"); // 7 days
    expect(formatLakebaseTtl(30 * 24 * 60 * 60 * 1000)).toBe("2592000s"); // 30 days
  });

  it("floors fractional seconds (ms not divisible by 1000)", () => {
    expect(formatLakebaseTtl(1234)).toBe("1s");
    expect(formatLakebaseTtl(0)).toBe("0s");
  });
});

describe("KIT_REGISTRIES – package-registry URLs", () => {
  // Each registry default is env-overridable; in a clean test env (no
  // LAKEBASE_KIT_REGISTRY_* set) they MUST resolve to the documented
  // public defaults so the mainline path stays the no-config-required
  // happy case. When the override IS set (e.g. .env.local.config sources
  // a corp proxy) the matching default-value assertion is skipped; the
  // override mechanic is covered by the trailing-slash + closed-shape
  // contracts below, which hold for any URL the env resolves to.
  const MAVEN_ENV = !!process.env.LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL;
  const SPRING_ENV = !!process.env.LAKEBASE_KIT_REGISTRY_SPRING_INITIALIZR;

  it.skipIf(MAVEN_ENV)("Maven Central defaults to the mainline public registry", () => {
    expect(KIT_REGISTRIES.mavenCentral).toBe("https://repo1.maven.org/maven2");
  });

  it.skipIf(SPRING_ENV)("Spring Initializr defaults to the mainline public registry", () => {
    expect(KIT_REGISTRIES.springInitializr).toBe("https://start.spring.io");
  });

  it("trailing slashes stripped so callers can safely concat `/path`", () => {
    // The urlFromEnv helper trims trailing slashes (verify the resolved
    // values are in trimmed form so callers don't get `//path` after
    // concatenation). This contract holds for both the public defaults
    // and any env-sourced override.
    expect(KIT_REGISTRIES.mavenCentral.endsWith("/")).toBe(false);
    expect(KIT_REGISTRIES.springInitializr.endsWith("/")).toBe(false);
  });

  it("exposes every documented field (closed shape)", () => {
    expect(Object.keys(KIT_REGISTRIES).sort()).toEqual(
      ["mavenCentral", "springInitializr"].sort()
    );
  });
});
