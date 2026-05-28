// Parent-aware schema diff between two Lakebase branches.
//
// Compares the target branch against its parent (the branch's sourceBranchId
// in Lakebase metadata) – for a feature forked from staging, that means diff
// vs staging, not vs production. Falls back to the project's default branch
// when source can't be resolved (e.g. for staging itself, or branches whose
// source has been deleted).
//
// Returns a structured SchemaDiffResult that matches the data contract the
// VS Code extension's per-table-diff modal consumes – same field names, same
// semantics, so once the extension re-routes (FEIP-7065 publish_and_consume),
// the modal can read identical JSON from either call site.

import { execFileSync } from "node:child_process";
import type { Pool } from "pg";
import { getConnection } from "./get-connection.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

export interface SchemaColumn {
  name: string;
  dataType: string;
}

export interface SchemaObject {
  type: "TABLE" | "INDEX";
  name: string;
  columns?: SchemaColumn[];
}

export interface ModifiedSchemaObject extends SchemaObject {
  type: "TABLE";
  columns: SchemaColumn[];
  addedColumns: SchemaColumn[];
  removedColumns: SchemaColumn[];
  prodColumns: SchemaColumn[];
}

export interface SchemaDiffResult {
  /** Branch the diff is FOR (target). */
  branchName: string;
  /**
   * The Lakebase branch this diff was computed AGAINST (the parent / source).
   * Empty string when unknown or when comparing the default branch itself.
   */
  comparisonBranchName: string;
  timestamp: string;
  /**
   * Always empty in the script-emitted result – migrations are a workspace
   * file concern, not a Lakebase-side concern. The extension fills this in
   * locally from its workspace's migrationPath.
   */
  migrations: Array<{ version: string; description: string }>;
  /** Tables on target that don't exist on the parent. */
  created: SchemaObject[];
  /** Tables on both branches with column differences. */
  modified: ModifiedSchemaObject[];
  /** Tables on parent that don't exist on the target. */
  removed: SchemaObject[];
  /** Full inventory of tables on the target branch. */
  branchTables: SchemaObject[];
  /** True iff created + modified + removed are all empty. */
  inSync: boolean;
  /** Populated when the diff couldn't be computed. Caller decides how to surface. */
  error?: string;
}

export interface GetSchemaDiffArgs {
  /** Lakebase project id. */
  instance: string;
  /** Target branch to compute the diff FOR. */
  branch: string;
  /**
   * Explicit comparison branch. When omitted, resolved via Lakebase metadata
   * (target's sourceBranchId → default branch fallback).
   */
  comparisonBranch?: string;
  /** Database name. Defaults to env PGDATABASE then "databricks_postgres". */
  database?: string;
  /** Optional WorkspaceClient pass-through to getConnection (OBO via AppKit). */
  workspaceClient?: unknown;
}

/** Skip this table in diffs – Flyway's bookkeeping isn't user schema. */
const IGNORED_TABLES = new Set(["flyway_schema_history"]);

const SCHEMA_QUERY =
  "SELECT c.table_name, c.column_name, c.data_type " +
  "FROM information_schema.columns c " +
  "JOIN pg_tables t ON c.table_name = t.tablename " +
  "WHERE c.table_schema='public' AND t.schemaname='public' " +
  "ORDER BY c.table_name, c.ordinal_position";

export async function getSchemaDiff(args: GetSchemaDiffArgs): Promise<SchemaDiffResult> {
  const timestamp = new Date().toISOString();
  const baseResult: SchemaDiffResult = {
    branchName: args.branch,
    comparisonBranchName: "",
    timestamp,
    migrations: [],
    created: [],
    modified: [],
    removed: [],
    branchTables: [],
    inSync: false,
  };

  const comparisonBranch = args.comparisonBranch ?? resolveComparisonBranch(args.instance, args.branch);
  if (!comparisonBranch) {
    return { ...baseResult, error: "Could not resolve a comparison target Lakebase branch" };
  }
  if (comparisonBranch === args.branch) {
    // Diff against self is vacuous.
    return { ...baseResult, comparisonBranchName: comparisonBranch, inSync: true };
  }

  let targetPool: Pool | undefined;
  let comparisonPool: Pool | undefined;
  try {
    targetPool = await getConnection({
      output: "pool",
      instance: args.instance,
      branch: args.branch,
      database: args.database,
      workspaceClient: args.workspaceClient,
    });
    comparisonPool = await getConnection({
      output: "pool",
      instance: args.instance,
      branch: comparisonBranch,
      database: args.database,
      workspaceClient: args.workspaceClient,
    });

    const targetTables = await listTables(targetPool);
    const comparisonTables = await listTables(comparisonPool);
    return diffSchemas(args.branch, comparisonBranch, targetTables, comparisonTables, timestamp);
  } catch (err) {
    return {
      ...baseResult,
      comparisonBranchName: comparisonBranch,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (targetPool) await targetPool.end().catch(() => undefined);
    if (comparisonPool) await comparisonPool.end().catch(() => undefined);
  }
}

interface TableRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

async function listTables(pool: Pool): Promise<Map<string, SchemaColumn[]>> {
  const { rows } = await pool.query<TableRow>(SCHEMA_QUERY);
  const tables = new Map<string, SchemaColumn[]>();
  for (const r of rows) {
    if (!r.table_name || IGNORED_TABLES.has(r.table_name)) continue;
    if (!tables.has(r.table_name)) tables.set(r.table_name, []);
    tables.get(r.table_name)!.push({ name: r.column_name, dataType: r.data_type });
  }
  return tables;
}

function diffSchemas(
  branch: string,
  comparisonBranch: string,
  target: Map<string, SchemaColumn[]>,
  comparison: Map<string, SchemaColumn[]>,
  timestamp: string
): SchemaDiffResult {
  const created: SchemaObject[] = [];
  const removed: SchemaObject[] = [];
  const modified: ModifiedSchemaObject[] = [];

  for (const [name, columns] of target) {
    if (!comparison.has(name)) {
      created.push({ type: "TABLE", name, columns });
    }
  }
  for (const [name, columns] of comparison) {
    if (!target.has(name)) {
      removed.push({ type: "TABLE", name, columns });
    }
  }
  for (const [name, targetCols] of target) {
    const comparisonCols = comparison.get(name);
    if (!comparisonCols) continue;
    const comparisonKeys = new Set(comparisonCols.map(colKey));
    const targetKeys = new Set(targetCols.map(colKey));
    const addedColumns = targetCols.filter((c) => !comparisonKeys.has(colKey(c)));
    const removedColumns = comparisonCols.filter((c) => !targetKeys.has(colKey(c)));
    if (addedColumns.length > 0 || removedColumns.length > 0) {
      modified.push({
        type: "TABLE",
        name,
        columns: targetCols,
        addedColumns,
        removedColumns,
        prodColumns: comparisonCols,
      });
    }
  }

  const branchTables: SchemaObject[] = [...target.entries()]
    .map(([name, columns]) => ({ type: "TABLE" as const, name, columns }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    branchName: branch,
    comparisonBranchName: comparisonBranch,
    timestamp,
    migrations: [],
    created: created.sort((a, b) => a.name.localeCompare(b.name)),
    modified: modified.sort((a, b) => a.name.localeCompare(b.name)),
    removed: removed.sort((a, b) => a.name.localeCompare(b.name)),
    branchTables,
    inSync: created.length === 0 && modified.length === 0 && removed.length === 0,
  };
}

const colKey = (c: SchemaColumn): string => `${c.name}:${c.dataType}`;

/**
 * Resolve the comparison branch via Lakebase metadata:
 *   1. target branch's `status.source_branch` (its parent), if set – this is
 *      a full resource path like `projects/x/branches/staging`; we trim to
 *      the leaf id since downstream CLI subresource URLs need branch_id.
 *   2. project's default branch, otherwise
 *   3. undefined if neither is resolvable
 *
 * Historical note: earlier code looked for `source_branch_id` at the top
 * level of `get-branch` responses. The Lakebase API actually nests it under
 * `status.source_branch` as the full path. Using the full path leaf means
 * we never need a uid→name lookup hop.
 */
function resolveComparisonBranch(instance: string, branch: string): string | undefined {
  const branchInfo = describeBranch(instance, branch);
  const sourceBranch = branchInfo?.status?.source_branch ?? branchInfo?.spec?.source_branch;
  if (sourceBranch && typeof sourceBranch === "string") {
    const leaf = sourceBranch.split("/branches/").pop();
    if (leaf) return leaf;
  }
  const def = findDefaultBranch(instance);
  if (def) return def;
  return undefined;
}

interface BranchMetadata {
  uid?: string;
  name?: string;
  status?: {
    default?: boolean;
    /** Parent branch's full resource name when the branch was forked. */
    source_branch?: string;
  };
  /** Kept as a fallback for list-branches responses that haven't surfaced status.source_branch. */
  spec?: { source_branch?: string };
  is_default?: boolean;
}

function describeBranch(instance: string, branch: string): BranchMetadata | undefined {
  const branchPath = `projects/${instance}/branches/${branch}`;
  try {
    const raw = dbcli(["postgres", "get-branch", branchPath, "-o", "json"]);
    return JSON.parse(raw) as BranchMetadata;
  } catch {
    // Fall back to scanning list-branches – older CLI versions may not expose
    // `get-branch`. Tolerate the gap silently; caller's metadata may simply
    // be unavailable.
    try {
      const raw = dbcli(["postgres", "list-branches", `projects/${instance}`, "-o", "json"]);
      const parsed = JSON.parse(raw) as BranchMetadata[] | { branches?: BranchMetadata[]; items?: BranchMetadata[] };
      const items = Array.isArray(parsed) ? parsed : parsed.branches ?? parsed.items ?? [];
      return items.find((b) => b.uid === branch || b.name?.endsWith(`/branches/${branch}`));
    } catch {
      return undefined;
    }
  }
}

function findDefaultBranch(instance: string): string | undefined {
  try {
    const raw = dbcli(["postgres", "list-branches", `projects/${instance}`, "-o", "json"]);
    const parsed = JSON.parse(raw) as BranchMetadata[] | { branches?: BranchMetadata[]; items?: BranchMetadata[] };
    const items = Array.isArray(parsed) ? parsed : parsed.branches ?? parsed.items ?? [];
    const def = items.find((b) => b.status?.default === true || b.is_default === true);
    if (!def) return undefined;
    // Prefer NAME (leaf of "projects/X/branches/Y") over UID – list-endpoints
    // accepts the name segment but rejects bare UIDs as "branch id not found".
    return def.name?.split("/branches/").pop() ?? def.uid ?? undefined;
  } catch {
    return undefined;
  }
}

function dbcli(args: string[]): string {
  return execFileSync("databricks", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KIT_TIMEOUTS.cliDefault,
  });
}
