// Live schema introspection against a Lakebase branch.
//
// Connects via the branch's primary endpoint and queries information_schema
// to inventory tables + columns. Used by schema-diff and any agent or
// extension that wants to inspect a branch's live structure without going
// through pg_dump.
//
// Credentials route through get-connection.ts (the single mint seam);
// pg client comes from the `pg` package (transitively available via
// @databricks/lakebase, plus a direct dep for clarity).

import { Client } from "pg";
import { getEndpoint, endpointPath as buildEndpointPath } from "./branch-endpoint.js";
import { resolveBranchId } from "./branch-utils.js";
import { mintCredential } from "./get-connection.js";

export interface TableSchema {
  name: string;
  columns: Array<{ name: string; dataType: string }>;
}

export interface QueryBranchSchemaArgs {
  instance: string;
  /**
   * Branch identifier. Accepts branch_id (e.g. "demo-feature"; tier names
   * "production" / "staging" / "uat" / "perf" are branch_ids), branch_uid
   * (e.g. "br-broad-sky-d2k5gewt"), or full resource path. Normalized
   * internally before any CLI URL is built.
   */
  branch: string;
  /** Default: $PGDATABASE then "databricks_postgres" */
  database?: string;
  /** Skip the flyway_schema_history table (default: true) */
  skipFlyway?: boolean;
}

const SCHEMA_QUERY =
  "SELECT c.table_name, c.column_name, c.data_type " +
  "FROM information_schema.columns c " +
  "JOIN pg_tables t ON c.table_name = t.tablename " +
  "WHERE c.table_schema='public' AND t.schemaname='public' " +
  "ORDER BY c.table_name, c.ordinal_position";

/**
 * Inventory the tables + columns on a Lakebase branch's public schema.
 *
 * Returns [] when the endpoint has no host yet (branch is still
 * provisioning) so callers can degrade gracefully. Throws only on
 * credential-minting / authentication failures, since those signal a
 * configuration problem the caller should surface.
 */
export async function queryBranchSchema(args: QueryBranchSchemaArgs): Promise<TableSchema[]> {
  // Normalize once. buildEndpointPath is sync + uses raw interpolation, so
  // every CLI path downstream needs branch_id (not uid). getEndpoint already
  // accepts either form via resolveBranchPath, but we normalize here so the
  // single shared `branchId` flows through both call sites consistently.
  const branchId = await resolveBranchId({ instance: args.instance, branch: args.branch });
  const ep = await getEndpoint({ instance: args.instance, branch: branchId });
  if (!ep?.host) {
    return [];
  }
  const { token, email } = await mintCredential(buildEndpointPath(args.instance, branchId));
  const database = args.database ?? process.env.PGDATABASE ?? "databricks_postgres";
  const skipFlyway = args.skipFlyway !== false;

  const client = new Client({
    host: ep.host,
    port: 5432,
    database,
    user: email,
    password: token,
    ssl: { rejectUnauthorized: false }, // Lakebase managed cert
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });

  try {
    await client.connect();
    const result = await client.query<{ table_name: string; column_name: string; data_type: string }>(
      SCHEMA_QUERY
    );
    const tables = new Map<string, Array<{ name: string; dataType: string }>>();
    for (const row of result.rows) {
      if (!row.table_name) continue;
      if (skipFlyway && row.table_name === "flyway_schema_history") continue;
      if (!tables.has(row.table_name)) {
        tables.set(row.table_name, []);
      }
      tables.get(row.table_name)!.push({ name: row.column_name, dataType: row.data_type });
    }
    return Array.from(tables.entries()).map(([name, columns]) => ({ name, columns }));
  } finally {
    try {
      await client.end();
    } catch {
      /* noop */
    }
  }
}

/** Convenience: just the table names, no column inventory. */
export async function queryBranchTables(args: QueryBranchSchemaArgs): Promise<string[]> {
  const schema = await queryBranchSchema(args);
  return schema.map(t => t.name);
}
