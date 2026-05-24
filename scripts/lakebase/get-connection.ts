// Single credential-minting seam for Lakebase-paired workflows.
//
// Two outputs over one OAuth substrate:
//
//   --output dsn  → postgresql:// URL string for Flyway / Alembic / psql
//                   (short-lived window, language-agnostic, operator principal)
//   --output pool → @databricks/lakebase pg.Pool with refresh-on-connect
//                   for JS callers (long-lived; OBO via AppKit when caller
//                   supplies a workspace client)
//
// No other file in this codebase should shell out to
// `databricks postgres generate-database-credential` – a CI grep guard
// (.github/workflows/grep-guard.yml) fails the build if it appears outside
// this module.

import { execFileSync } from "node:child_process";
import { createLakebasePool } from "@databricks/lakebase";
import type { Pool } from "pg";
// AppKit / @databricks/lakebase re-exports a WorkspaceClient type that
// matches what createLakebasePool expects. We accept `unknown` at the API
// boundary so this module doesn't have to take a hard SDK dep just to type
// an opaque pass-through.

export interface GetConnectionArgs {
  /**
   * Lakebase project id (e.g. "proj-abc123"). Maps to
   * `projects/<instance>` in the Databricks resource hierarchy.
   */
  instance: string;
  /**
   * Branch id within the project (e.g. "br-feature-xyz"). Maps to
   * `projects/<instance>/branches/<branch>`.
   */
  branch: string;
  /**
   * Endpoint identifier on the branch. Defaults to "primary" – the only
   * value the extension uses today (see lakebaseService.getCredential).
   */
  endpointName?: string;
  /**
   * Database name to connect to. Defaults to env PGDATABASE, then
   * "databricks_postgres".
   */
  database?: string;
  /**
   * For --output pool, an optional WorkspaceClient (from
   * @databricks/sdk-experimental). Pass when you want On-Behalf-Of behavior
   * via AppKit; omit to let @databricks/lakebase resolve from environment.
   */
  workspaceClient?: unknown;
}

export interface DsnArgs extends GetConnectionArgs {
  output: "dsn";
}

export interface PoolArgs extends GetConnectionArgs {
  output: "pool";
}

export type ConnectionArgs = DsnArgs | PoolArgs;

export interface DsnResult {
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
  endpointPath: string;
}

export function getConnection(args: DsnArgs): Promise<DsnResult>;
export function getConnection(args: PoolArgs): Promise<Pool>;
export async function getConnection(args: ConnectionArgs): Promise<DsnResult | Pool> {
  const endpointName = args.endpointName ?? "primary";
  const database = args.database ?? process.env.PGDATABASE ?? "databricks_postgres";
  const endpointPath = `projects/${args.instance}/branches/${args.branch}/endpoints/${endpointName}`;

  if (args.output === "dsn") {
    const host = await resolveEndpointHost(args.instance, args.branch);
    const { token, email } = await mintCredential(endpointPath);
    const url = buildPostgresUrl({ host, port: 5432, database, user: email, password: token });
    return { url, host, port: 5432, database, user: email, endpointPath };
  }

  // output === "pool"
  const host = await resolveEndpointHost(args.instance, args.branch);
  const email = await resolveCurrentUser();
  return createLakebasePool({
    endpoint: endpointPath,
    host,
    database,
    user: email,
    // workspaceClient is passed through verbatim. createLakebasePool falls
    // back to environment / ServiceContext when omitted.
    ...(args.workspaceClient !== undefined
      ? { workspaceClient: args.workspaceClient as never }
      : {}),
  });
}

export async function resolveEndpointHost(instance: string, branch: string): Promise<string> {
  const branchPath = `projects/${instance}/branches/${branch}`;
  const raw = dbcli(["postgres", "list-endpoints", branchPath, "-o", "json"]);
  const endpoints = JSON.parse(raw) as Array<{ status?: { hosts?: { host?: string } } }>;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error(`No endpoints found for branch ${branchPath}`);
  }
  const host = endpoints[0]?.status?.hosts?.host;
  if (!host) {
    throw new Error(`Endpoint exists for ${branchPath} but has no host yet – wait for it to become ACTIVE`);
  }
  return host;
}

/**
 * Mint a short-lived Lakebase credential against a branch endpoint.
 *
 * This is the ONLY function that should call
 * `databricks postgres generate-database-credential` anywhere in the codebase.
 * A CI grep guard enforces that – every other workflow op (schema queries,
 * direct pg.Pool construction, DSN building) must go through this helper.
 *
 * @param endpointPath Full Lakebase endpoint resource path
 *   (e.g. `projects/my-app/branches/feature-x/endpoints/primary`)
 */
export async function mintCredential(endpointPath: string): Promise<{ token: string; email: string }> {
  // ── single point of credential minting in the entire codebase ──
  const raw = dbcli(["postgres", "generate-database-credential", endpointPath, "-o", "json"]);
  const token = (JSON.parse(raw)?.token ?? "") as string;
  if (!token) {
    throw new Error(`generate-database-credential returned no token for ${endpointPath}`);
  }
  const email = await resolveCurrentUser();
  return { token, email };
}

export async function resolveCurrentUser(): Promise<string> {
  const raw = dbcli(["current-user", "me", "-o", "json"]);
  const parsed = JSON.parse(raw) as {
    userName?: string;
    emails?: Array<{ value?: string }>;
  };
  const email = parsed.userName ?? parsed.emails?.[0]?.value;
  if (!email) {
    throw new Error("Could not resolve current user from `databricks current-user me`");
  }
  return email;
}

function buildPostgresUrl(parts: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string {
  const u = new URL(`postgresql://${parts.host}:${parts.port}/${encodeURIComponent(parts.database)}`);
  u.username = encodeURIComponent(parts.user);
  u.password = encodeURIComponent(parts.password);
  u.searchParams.set("sslmode", "require");
  return u.toString();
}

function dbcli(args: string[]): string {
  try {
    return execFileSync("databricks", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : "";
    throw new Error(
      `databricks ${args.join(" ")} failed: ${e.message}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`
    );
  }
}
