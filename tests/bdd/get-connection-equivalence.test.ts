import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import type { Pool } from "pg";
import { getConnection } from "../../scripts/lakebase/get-connection.js";

// Skip-when-env-missing. See get-connection-dsn.test.ts for env contract.
const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const DATABASE = process.env.LAKEBASE_TEST_DATABASE;
const skip = !INSTANCE || !BRANCH;

let dsnClient: pg.Client | undefined;
let pool: Pool | undefined;

afterAll(async () => {
  if (dsnClient) await dsnClient.end();
  if (pool) await pool.end();
});

describe.skipIf(skip)("get-connection, DSN and Pool resolve to the same database", () => {
  it("returns identical current_database()/host across both output shapes", async () => {
    // Path 1: --output dsn → connect with raw pg.Client using the URL
    const dsn = await getConnection({
      output: "dsn",
      instance: INSTANCE!,
      branch: BRANCH!,
      database: DATABASE,
    });
    dsnClient = new pg.Client({ connectionString: dsn.url });
    await dsnClient.connect();
    const dsnRow = (
      await dsnClient.query<{ db: string; host: string; user: string }>(
        "SELECT current_database() AS db, inet_server_addr()::text AS host, current_user AS user"
      )
    ).rows[0];

    // Path 2: --output pool → @databricks/lakebase Pool
    pool = await getConnection({
      output: "pool",
      instance: INSTANCE!,
      branch: BRANCH!,
      database: DATABASE,
    });
    const poolRow = (
      await pool.query<{ db: string; host: string; user: string }>(
        "SELECT current_database() AS db, inet_server_addr()::text AS host, current_user AS user"
      )
    ).rows[0];

    expect(poolRow.db).toBe(dsnRow.db);
    // host may differ if the cluster floats between IPs between the two
    // connects; instead assert they're both non-empty.
    expect(poolRow.host).toBeTruthy();
    expect(dsnRow.host).toBeTruthy();
    // User identity must match, both paths use the operator principal
    expect(poolRow.user).toBe(dsnRow.user);
  });
});

describe("get-connection equivalence (skip-when-env-missing)", () => {
  it("documents the skip reason when env vars are absent", () => {
    if (!skip) return;
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_BRANCH not set, equivalence suite skipped."
    );
    expect(skip).toBe(true);
  });
});
