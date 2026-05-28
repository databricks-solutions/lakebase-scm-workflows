import { describe, it, expect, vi } from "vitest";

// kit-config is the single source of truth for every timeout the
// substrate scatters across its files. Two layers under test:
//   1. Documented defaults  (clean env, no LAKEBASE_KIT_* set)
//   2. Env-override mechanic (intFromEnv / urlFromEnv pick up env var)
//
// The module is read once at import time, so verifying both layers in a
// single test file requires loading it under a controlled env. We use
// vi.resetModules() + scoped env mutation so every assertion runs
// unconditionally (no skipIf gating, no contributor-actionable skips).

const KIT_ENV_VARS = [
  "LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS",
  "LAKEBASE_KIT_TIMEOUT_CLI_CREATE_BRANCH_MS",
  "LAKEBASE_KIT_TIMEOUT_CLI_CREATE_ENDPOINT_MS",
  "LAKEBASE_KIT_TIMEOUT_READY_WAIT_MS",
  "LAKEBASE_KIT_TIMEOUT_READY_POLL_MS",
  "LAKEBASE_KIT_TIMEOUT_PG_CONNECT_MS",
  "LAKEBASE_KIT_TIMEOUT_PG_STATEMENT_MS",
  "LAKEBASE_KIT_TIMEOUT_GIT_DEFAULT_MS",
  "LAKEBASE_KIT_TIMEOUT_GIT_CHECKOUT_MS",
  "LAKEBASE_KIT_TIMEOUT_GIT_NETWORK_MS",
  "LAKEBASE_KIT_TIMEOUT_GIT_PUSH_MS",
  "LAKEBASE_KIT_TIMEOUT_CLI_LONG_MS",
  "LAKEBASE_KIT_TIMEOUT_CMD_SHORT_MS",
  "LAKEBASE_KIT_INITIALIZR_CACHE_TTL_MS",
  "LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS",
  "LAKEBASE_KIT_TEST_BRANCH_TTL_MS",
  "LAKEBASE_KIT_UAT_BRANCH_TTL_MS",
  "LAKEBASE_KIT_PERF_BRANCH_TTL_MS",
  "LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL",
  "LAKEBASE_KIT_REGISTRY_SPRING_INITIALIZR",
];

// Load kit-config under a controlled env. The `overrides` map is the
// only kit env active during module init; every other LAKEBASE_KIT_* is
// scrubbed so the documented-default branch runs deterministically even
// when the surrounding process inherits values (e.g. .env.local.config
// sourced by run-all-live-tests.sh).
async function loadKitConfig(overrides: Record<string, string | undefined> = {}) {
  const saved: Record<string, string | undefined> = {};
  for (const v of KIT_ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    vi.resetModules();
    return await import("../../scripts/lakebase/kit-config");
  } finally {
    for (const v of KIT_ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
}

describe("KIT_TIMEOUTS – documented defaults (clean env)", () => {
  it("CLI invocations fall in the 30s default / 60s long bands", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    expect(KIT_TIMEOUTS.cliDefault).toBe(30_000);
    expect(KIT_TIMEOUTS.cliCreateBranch).toBe(60_000);
    expect(KIT_TIMEOUTS.cliCreateEndpoint).toBe(60_000);
    expect(KIT_TIMEOUTS.cliLong).toBe(60_000);
  });

  it("wait-for-READY uses a 2-minute budget with 5s polls", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    expect(KIT_TIMEOUTS.readyWait).toBe(120_000);
    expect(KIT_TIMEOUTS.readyPoll).toBe(5_000);
  });

  it("Postgres client timeouts: 10s connect / 15s statement", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    expect(KIT_TIMEOUTS.pgConnect).toBe(10_000);
    expect(KIT_TIMEOUTS.pgStatement).toBe(15_000);
  });

  it("git operations: 5s local / 10s checkout / 15s network / 30s push", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    expect(KIT_TIMEOUTS.gitDefault).toBe(5_000);
    expect(KIT_TIMEOUTS.gitCheckout).toBe(10_000);
    expect(KIT_TIMEOUTS.gitNetwork).toBe(15_000);
    expect(KIT_TIMEOUTS.gitPush).toBe(30_000);
  });

  it("short helper commands are 5s by default", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    expect(KIT_TIMEOUTS.cmdShort).toBe(5_000);
  });

  it("Spring Initializr metadata cache TTL is 10 minutes", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    expect(KIT_TIMEOUTS.initializrCacheTtl).toBe(10 * 60 * 1000);
  });

  it("convention branch TTLs match PSA defaults (30d feature / 14d test+uat / 7d perf)", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(KIT_TIMEOUTS.featureBranchTtlMs).toBe(30 * DAY_MS);
    expect(KIT_TIMEOUTS.testBranchTtlMs).toBe(14 * DAY_MS);
    expect(KIT_TIMEOUTS.uatBranchTtlMs).toBe(14 * DAY_MS);
    expect(KIT_TIMEOUTS.perfBranchTtlMs).toBe(7 * DAY_MS);
  });

  it("every value is a positive integer (env-override fallback contract)", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
    for (const [name, value] of Object.entries(KIT_TIMEOUTS)) {
      expect(typeof value, `${name} should be a number`).toBe("number");
      expect(Number.isFinite(value), `${name} should be finite`).toBe(true);
      expect(value, `${name} should be positive`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `${name} should be an integer`).toBe(true);
    }
  });

  it("exposes every documented field (closed shape)", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig();
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

describe("KIT_TIMEOUTS – env-override mechanic", () => {
  it("LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS overrides the 30-day default", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig({
      LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS: "604800000", // 7 days
    });
    expect(KIT_TIMEOUTS.featureBranchTtlMs).toBe(604_800_000);
  });

  it("LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS overrides the 30s default", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig({
      LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS: "45000",
    });
    expect(KIT_TIMEOUTS.cliDefault).toBe(45_000);
  });

  it("non-numeric env value falls back to the documented default", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig({
      LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS: "not-a-number",
    });
    expect(KIT_TIMEOUTS.cliDefault).toBe(30_000);
  });

  it("non-positive env value falls back to the documented default", async () => {
    const { KIT_TIMEOUTS } = await loadKitConfig({
      LAKEBASE_KIT_TIMEOUT_CLI_DEFAULT_MS: "0",
    });
    expect(KIT_TIMEOUTS.cliDefault).toBe(30_000);
  });
});

describe("formatLakebaseTtl – protobuf Duration format", () => {
  it("formats ms to `<seconds>s` as Lakebase expects in create-branch specs", async () => {
    const { formatLakebaseTtl } = await loadKitConfig();
    expect(formatLakebaseTtl(86_400_000)).toBe("86400s"); // 1 day
    expect(formatLakebaseTtl(7 * 24 * 60 * 60 * 1000)).toBe("604800s"); // 7 days
    expect(formatLakebaseTtl(30 * 24 * 60 * 60 * 1000)).toBe("2592000s"); // 30 days
  });

  it("floors fractional seconds (ms not divisible by 1000)", async () => {
    const { formatLakebaseTtl } = await loadKitConfig();
    expect(formatLakebaseTtl(1234)).toBe("1s");
    expect(formatLakebaseTtl(0)).toBe("0s");
  });
});

describe("KIT_REGISTRIES – package-registry URLs (clean env)", () => {
  it("Maven Central defaults to the mainline public registry", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig();
    expect(KIT_REGISTRIES.mavenCentral).toBe("https://repo1.maven.org/maven2");
  });

  it("Spring Initializr defaults to the mainline public registry", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig();
    expect(KIT_REGISTRIES.springInitializr).toBe("https://start.spring.io");
  });

  it("trailing slashes stripped so callers can safely concat `/path`", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig();
    expect(KIT_REGISTRIES.mavenCentral.endsWith("/")).toBe(false);
    expect(KIT_REGISTRIES.springInitializr.endsWith("/")).toBe(false);
  });

  it("exposes every documented field (closed shape)", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig();
    expect(Object.keys(KIT_REGISTRIES).sort()).toEqual(
      ["mavenCentral", "springInitializr"].sort()
    );
  });
});

describe("KIT_REGISTRIES – env-override mechanic", () => {
  it("LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL overrides the public default", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig({
      LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL: "https://maven-proxy.example.com",
    });
    expect(KIT_REGISTRIES.mavenCentral).toBe("https://maven-proxy.example.com");
  });

  it("LAKEBASE_KIT_REGISTRY_SPRING_INITIALIZR overrides the public default", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig({
      LAKEBASE_KIT_REGISTRY_SPRING_INITIALIZR: "https://spring-mirror.example.com",
    });
    expect(KIT_REGISTRIES.springInitializr).toBe("https://spring-mirror.example.com");
  });

  it("trailing slashes are stripped from env overrides", async () => {
    const { KIT_REGISTRIES } = await loadKitConfig({
      LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL: "https://maven-proxy.example.com//",
    });
    expect(KIT_REGISTRIES.mavenCentral).toBe("https://maven-proxy.example.com");
  });
});
