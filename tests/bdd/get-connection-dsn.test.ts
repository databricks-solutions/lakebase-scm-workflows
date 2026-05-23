import { describe, it, expect } from "vitest";
import { getConnection } from "../../scripts/lakebase/get-connection.js";

// Skip-when-env-missing: this suite requires a real, reachable Lakebase
// project + branch and a `databricks` CLI authenticated to the same
// workspace. Set:
//
//   LAKEBASE_TEST_INSTANCE   project id (e.g. proj-abc123)
//   LAKEBASE_TEST_BRANCH     branch id (e.g. br-test-feature)
//   LAKEBASE_TEST_DATABASE   optional, defaults to databricks_postgres
//
// When the env vars are absent we skip rather than fail — CI without
// Lakebase creds stays green; local runs with creds prove the helper
// against the real control plane.

const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const DATABASE = process.env.LAKEBASE_TEST_DATABASE;
const skip = !INSTANCE || !BRANCH;

describe.skipIf(skip)("get-connection --output dsn", () => {
  it("returns a parseable postgresql:// URL with the required components", async () => {
    const result = await getConnection({
      output: "dsn",
      instance: INSTANCE!,
      branch: BRANCH!,
      database: DATABASE,
    });

    expect(result.url).toMatch(/^postgresql:\/\//);
    const u = new URL(result.url);
    expect(u.protocol).toBe("postgresql:");
    expect(u.hostname).toBe(result.host);
    expect(u.port).toBe(String(result.port));
    expect(u.port).toBe("5432");
    // username/password URL-encoded — decoded values should be non-empty
    expect(decodeURIComponent(u.username)).not.toBe("");
    expect(decodeURIComponent(u.password)).not.toBe("");
    // database is path-encoded
    expect(decodeURIComponent(u.pathname.slice(1))).toBe(result.database);
    expect(u.searchParams.get("sslmode")).toBe("require");
  });

  it("resolves the correct endpoint path", async () => {
    const result = await getConnection({
      output: "dsn",
      instance: INSTANCE!,
      branch: BRANCH!,
    });
    expect(result.endpointPath).toBe(
      `projects/${INSTANCE}/branches/${BRANCH}/endpoints/primary`
    );
  });
});

describe("get-connection --output dsn (skip-when-env-missing)", () => {
  it("documents the skip reason when env vars are absent", () => {
    if (!skip) {
      // suite runs — nothing to document
      return;
    }
    // Surface the missing env so CI logs make the gap obvious.
    // (Vitest renders this as a passing test with a console message; it
    // exists so a reader scanning the report sees why the live suite
    // didn't fire.)
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_BRANCH not set — DSN live suite skipped."
    );
    expect(skip).toBe(true);
  });
});
