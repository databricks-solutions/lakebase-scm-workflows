import { describe, it, expect, afterAll } from "vitest";
import type { Pool } from "pg";
import { getConnection } from "../../scripts/lakebase/get-connection.js";

// Skip-when-env-missing. See get-connection-dsn.test.ts for env contract.
const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const DATABASE = process.env.LAKEBASE_TEST_DATABASE;
const skip = !INSTANCE || !BRANCH;

let pool: Pool | undefined;

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
});

describe.skipIf(skip)("get-connection --output pool", () => {
  it("returns a working @databricks/lakebase pg.Pool that can SELECT 1", async () => {
    pool = await getConnection({
      output: "pool",
      instance: INSTANCE!,
      branch: BRANCH!,
      database: DATABASE,
    });

    const { rows } = await pool.query<{ one: number }>("SELECT 1 AS one");
    expect(rows).toHaveLength(1);
    expect(rows[0].one).toBe(1);
  });

  it("reports the expected database via current_database()", async () => {
    if (!pool) {
      pool = await getConnection({
        output: "pool",
        instance: INSTANCE!,
        branch: BRANCH!,
        database: DATABASE,
      });
    }
    const expectedDb = DATABASE ?? "databricks_postgres";
    const { rows } = await pool.query<{ db: string }>("SELECT current_database() AS db");
    expect(rows[0].db).toBe(expectedDb);
  });
});

describe("get-connection --output pool (skip-when-env-missing)", () => {
  it("documents the skip reason when env vars are absent", () => {
    if (!skip) return;
    // eslint-disable-next-line no-console
    console.log(
      "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_BRANCH not set, Pool live suite skipped."
    );
    expect(skip).toBe(true);
  });
});
