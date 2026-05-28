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

  it("convention branch TTLs match the PSA defaults (30d feature / 14d test+uat / 7d perf)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(KIT_TIMEOUTS.featureBranchTtlMs).toBe(30 * DAY_MS);
    expect(KIT_TIMEOUTS.testBranchTtlMs).toBe(14 * DAY_MS);
    expect(KIT_TIMEOUTS.uatBranchTtlMs).toBe(14 * DAY_MS);
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
  it("defaults to the mainline public registries", () => {
    // These are env-overridable; in a clean test env (no LAKEBASE_KIT_REGISTRY_*
    // set) they MUST resolve to the documented public defaults so the
    // mainline path stays the no-config-required happy case.
    expect(KIT_REGISTRIES.mavenCentral).toBe("https://repo1.maven.org/maven2");
    expect(KIT_REGISTRIES.springInitializr).toBe("https://start.spring.io");
  });

  it("trailing slashes stripped so callers can safely concat `/path`", () => {
    // The urlFromEnv helper trims trailing slashes – verify the defaults
    // are already in trimmed form (a regression here would mean callers
    // get `//path` after concatenation).
    expect(KIT_REGISTRIES.mavenCentral.endsWith("/")).toBe(false);
    expect(KIT_REGISTRIES.springInitializr.endsWith("/")).toBe(false);
  });

  it("exposes every documented field (closed shape)", () => {
    expect(Object.keys(KIT_REGISTRIES).sort()).toEqual(
      ["mavenCentral", "springInitializr"].sort()
    );
  });
});
