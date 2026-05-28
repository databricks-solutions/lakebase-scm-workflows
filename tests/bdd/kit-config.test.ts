import { describe, it, expect } from "vitest";
import { KIT_TIMEOUTS } from "../../scripts/lakebase/kit-config";

// kit-config is the single source of truth for every timeout the
// substrate scatters across its files. The test pins documented
// defaults + the env-override surface so a future tuning change
// doesn't quietly drift them out of sync.
//
// Env-override coverage: KIT_TIMEOUTS is read once at module load.
// Verifying the env-override mechanic itself requires loading the
// module fresh with new env, which isn't worth the vitest gymnastics
// here — the override path is straightforward (intFromEnv falls back
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
      ].sort()
    );
  });
});
