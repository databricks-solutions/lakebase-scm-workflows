import { describe, it, expect } from "vitest";
import { getSchemaDiff } from "../../scripts/lakebase/schema-diff.js";

// Skip-when-env-missing. See get-connection-dsn.test.ts for the env contract.
// schema-diff additionally needs a second branch to compare against, set
// LAKEBASE_TEST_COMPARISON_BRANCH to pin it, or leave unset and let the
// resolver pick up the target's source-branch / default-branch.
const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const COMPARISON = process.env.LAKEBASE_TEST_COMPARISON_BRANCH;
const DATABASE = process.env.LAKEBASE_TEST_DATABASE;
const skip = !INSTANCE || !BRANCH;

// schema-diff's getConnection retries up to ~16s on transient
// "branch id not found" / endpoint-not-yet-provisioned errors (substrate
// option C). Tests that run against freshly-created branches need a
// timeout budget that comfortably exceeds the retry window, vitest's 5s
// default trips before the first successful endpoint lookup. 60s is two
// retry cycles plus connect+query slack.
const LIVE_TEST_TIMEOUT_MS = 60_000;

describe.skipIf(skip)("schema-diff against real Lakebase", () => {
  it("returns the documented SchemaDiffResult shape", async () => {
    const result = await getSchemaDiff({
      instance: INSTANCE!,
      branch: BRANCH!,
      comparisonBranch: COMPARISON,
      database: DATABASE,
    });

    // Required top-level fields
    expect(result.branchName).toBe(BRANCH);
    expect(typeof result.comparisonBranchName).toBe("string");
    expect(typeof result.timestamp).toBe("string");
    expect(Array.isArray(result.migrations)).toBe(true);
    expect(Array.isArray(result.created)).toBe(true);
    expect(Array.isArray(result.modified)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.branchTables)).toBe(true);
    expect(typeof result.inSync).toBe("boolean");

    // Modified rows must carry the legacy modal-compatible columns
    for (const m of result.modified) {
      expect(m.type).toBe("TABLE");
      expect(Array.isArray(m.addedColumns)).toBe(true);
      expect(Array.isArray(m.removedColumns)).toBe(true);
      expect(Array.isArray(m.prodColumns)).toBe(true);
    }

    // No flyway bookkeeping leaks into either side
    const allTableNames = new Set([
      ...result.branchTables.map((t) => t.name),
      ...result.created.map((t) => t.name),
      ...result.removed.map((t) => t.name),
    ]);
    expect(allTableNames.has("flyway_schema_history")).toBe(false);

    // inSync must be consistent with the change arrays. A failure here
    // means either (a) the diff logic is broken, or (b) we never reached
    // the diff because getConnection couldn't resolve the branch's
    // endpoint. (b) is a substrate concern: getConnection retries on
    // transient "branch id not found" so the test's empty=empty fork
    // reaches the happy path. The test deliberately does NOT exempt the
    // error case, if it surfaces, that's a real substrate regression.
    expect(result.error).toBeUndefined();
    if (result.created.length === 0 && result.modified.length === 0 && result.removed.length === 0) {
      expect(result.inSync).toBe(true);
    } else {
      expect(result.inSync).toBe(false);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  it("is deterministic across calls (sorted output)", async () => {
    const a = await getSchemaDiff({
      instance: INSTANCE!,
      branch: BRANCH!,
      comparisonBranch: COMPARISON,
      database: DATABASE,
    });
    const b = await getSchemaDiff({
      instance: INSTANCE!,
      branch: BRANCH!,
      comparisonBranch: COMPARISON,
      database: DATABASE,
    });
    expect(a.branchTables.map((t) => t.name)).toEqual(b.branchTables.map((t) => t.name));
    expect(a.created.map((t) => t.name)).toEqual(b.created.map((t) => t.name));
    expect(a.modified.map((t) => t.name)).toEqual(b.modified.map((t) => t.name));
    expect(a.removed.map((t) => t.name)).toEqual(b.removed.map((t) => t.name));
  }, LIVE_TEST_TIMEOUT_MS);
});

describe("schema-diff (skip-when-env-missing)", () => {
  it("documents the skip reason when env vars are absent", () => {
    if (!skip) return;
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_BRANCH not set, schema-diff live suite skipped."
    );
    expect(skip).toBe(true);
  });
});
