import { describe, it, expect } from "vitest";
import {
  POSTGRES_PORT,
  DEFAULT_DATABASE,
  DEFAULT_ENDPOINT,
} from "../../scripts/lakebase/constants";

// Pin the substrate's documented defaults. These constants are imported
// by every callsite that previously inlined the literal (4× port, 4×
// database name, 4× endpoint name). The test guards two things:
//
//   1. The values match the documented Lakebase defaults today. A
//      deliberate future change (e.g. service moves off 5432) is fine
//      – bump the literal here and the substrate everywhere flips
//      together.
//   2. The shape stays stable: `POSTGRES_PORT` is a number, the two
//      string defaults are non-empty.
//
// Live tests that actually CONNECT to a Lakebase branch (get-connection,
// branch-schema, etc.) provide the runtime proof that the substrate's
// use of these constants matches what the service expects.

describe("substrate shared constants", () => {
  it("POSTGRES_PORT is 5432 (Lakebase's fixed Postgres port)", () => {
    expect(POSTGRES_PORT).toBe(5432);
    expect(typeof POSTGRES_PORT).toBe("number");
  });

  it("DEFAULT_DATABASE is 'databricks_postgres' (Lakebase's per-branch db)", () => {
    expect(DEFAULT_DATABASE).toBe("databricks_postgres");
    expect(DEFAULT_DATABASE.length).toBeGreaterThan(0);
  });

  it("DEFAULT_ENDPOINT is 'primary' (Lakebase's single per-branch endpoint)", () => {
    expect(DEFAULT_ENDPOINT).toBe("primary");
    expect(DEFAULT_ENDPOINT.length).toBeGreaterThan(0);
  });
});
