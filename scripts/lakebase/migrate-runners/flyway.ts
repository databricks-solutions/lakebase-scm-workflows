// Flyway runner for Java + Kotlin projects (FEIP-7098).
//
// Shells to the standalone Flyway Community Edition CLI in JSON output
// mode. The runner reads the project's migration files from
// `src/main/resources/db/migration/` (Flyway's standard layout). It
// passes connection info through FLYWAY_URL / FLYWAY_USER /
// FLYWAY_PASSWORD env vars rather than command-line flags so the
// secret never appears in `ps`.
//
// The runner does NOT use `mvn flyway:migrate`. Reasons:
//   - Avoids dragging a project-specific Maven/Spring Boot build into
//     primitives that should be runtime-light.
//   - Lets the primitive work on Maven projects that have not
//     configured the flyway-maven-plugin yet.
//   - JSON output mode gives a stable parse target.
//
// Real-world Maven users still get Flyway migrations executed on app
// startup via spring-boot-starter-data-jpa + flyway-core; this runner
// is what programmatic callers (CLI, MCP, e2e tests) drive.
//
// Rollback is intentionally unimplemented: Flyway Community Edition
// does not support `undo`. Users must roll forward with a compensating
// migration.

import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  MigrationError,
  type ApplyMigrationsResult,
  type RollbackMigrationResult,
  type MigrationStatusResult,
  type AppliedMigration,
  type PendingMigration,
} from "../migrate.js";

interface FlywayCtx {
  projectDir: string;
  dsn: string;
}

/** Convert a Lakebase postgresql:// DSN into the parts Flyway expects. */
function dsnToFlywayEnv(dsn: string): { url: string; user: string; password: string } {
  const u = new URL(dsn);
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  // Strip credentials from the URL, prefix with `jdbc:`. Preserve port,
  // path, and query (sslmode=require etc.).
  const portPart = u.port ? `:${u.port}` : "";
  const url = `jdbc:postgresql://${u.hostname}${portPart}${u.pathname}${u.search}`;
  return { url, user, password };
}

function migrationsLocation(projectDir: string): string {
  return `filesystem:${path.join(projectDir, "src", "main", "resources", "db", "migration")}`;
}

interface FlywayRun {
  stdout: string;
  stderr: string;
}

function runFlyway(ctx: FlywayCtx, args: string[]): Promise<FlywayRun> {
  const { url, user, password } = dsnToFlywayEnv(ctx.dsn);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "flyway",
      ["-outputType=json", `-locations=${migrationsLocation(ctx.projectDir)}`, ...args],
      {
        cwd: ctx.projectDir,
        env: {
          ...process.env,
          FLYWAY_URL: url,
          FLYWAY_USER: user,
          FLYWAY_PASSWORD: password,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new MigrationError(
          `Could not spawn flyway. Is the Flyway Community CLI installed and on PATH? ${err.message}`,
          err
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new MigrationError(
            `flyway ${args.join(" ")} exited with code ${code}.\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`
          )
        );
      }
    });
  });
}

/**
 * Flyway -outputType=json emits a top-level object whose useful keys
 * include `migrations` (array of objects). Different commands populate
 * slightly different fields:
 *
 *   - `migrate`: each entry has { version, description, type, filepath,
 *                                  executionTime, category } for what was
 *                                  executed in this run.
 *   - `info`:    each entry has { version, description, type, filepath,
 *                                  state } for the full inventory.
 *
 * We accept either and let the caller assert the keys it cares about.
 */
interface FlywayJson {
  migrations?: Array<{
    version?: string;
    description?: string;
    type?: string;
    filepath?: string;
    state?: string;
    category?: string;
    executionTime?: number;
  }>;
  // Flyway also emits a top-level "error" object on failure, but
  // non-zero exit codes already surface that path via runFlyway.
  [key: string]: unknown;
}

function parseFlywayJson(stdout: string): FlywayJson {
  // Flyway sometimes prints license / banner text before the JSON when
  // -outputType=json is set in older versions. Find the first '{'.
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new MigrationError(`flyway JSON output missing: ${stdout.slice(0, 200)}`);
  }
  try {
    return JSON.parse(stdout.slice(start)) as FlywayJson;
  } catch (err) {
    throw new MigrationError(
      `flyway JSON parse failed: ${err instanceof Error ? err.message : String(err)}.\n` +
        `Body (first 400 chars): ${stdout.slice(start, start + 400)}`
    );
  }
}

export async function applyFlyway(ctx: FlywayCtx): Promise<ApplyMigrationsResult> {
  // Lakebase's default Postgres database always has a non-empty `public`
  // schema (system tables, extensions). Without these flags Flyway 9+
  // refuses to migrate against it: `NON_EMPTY_SCHEMA_WITHOUT_SCHEMA_HISTORY_TABLE`.
  // baselineOnMigrate=true creates the schema history table on the
  // first migrate; baselineVersion=0 ensures every user migration
  // (V1, V2, ...) is treated as pending instead of being shadowed by
  // an auto-baseline at V1.
  const { stdout } = await runFlyway(ctx, [
    "-baselineOnMigrate=true",
    "-baselineVersion=0",
    "migrate",
  ]);
  const json = parseFlywayJson(stdout);
  const entries = json.migrations ?? [];

  const applied: AppliedMigration[] = [];
  for (const m of entries) {
    if (m.category === "INIT") continue; // baseline placeholder
    if (m.state && m.state !== "SUCCESS") continue;
    if (!m.version) continue;
    applied.push({
      version: m.version,
      description: m.description ?? "",
      ...(typeof m.executionTime === "number" ? { executionTimeMs: m.executionTime } : {}),
    });
  }

  return {
    applied,
    alreadyAtLatest: applied.length === 0,
    tool: "flyway",
  };
}

export async function rollbackFlyway(
  _ctx: FlywayCtx & { target: string }
): Promise<RollbackMigrationResult> {
  throw new MigrationError(
    "Flyway Community Edition does not support undo / rollback. " +
      "Roll forward with a compensating migration. " +
      "(Flyway Teams Edition has `flyway undo`, but the kit targets Community.)"
  );
}

export async function statusFlyway(ctx: FlywayCtx): Promise<MigrationStatusResult> {
  const { stdout } = await runFlyway(ctx, ["info"]);
  const json = parseFlywayJson(stdout);
  const entries = json.migrations ?? [];

  let current: string | undefined;
  const pending: PendingMigration[] = [];

  for (const m of entries) {
    if (!m.version) continue;
    // Flyway info states we care about: SUCCESS, PENDING, BASELINE,
    // ABOVE_TARGET, MISSING_SUCCESS, MISSING_FAILED, FUTURE_*, IGNORED,
    // OUTDATED, UNDONE. We treat anything applied (SUCCESS, BASELINE)
    // as the new current head; anything PENDING goes into the pending
    // list.
    const state = (m.state ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "BASELINE") {
      current = m.version;
    } else if (state === "PENDING") {
      const filename = m.filepath ? path.basename(m.filepath) : `V${m.version}__migration.sql`;
      pending.push({
        version: m.version,
        filename,
        description: m.description ?? "",
      });
    }
  }

  return { current, pending, tool: "flyway" };
}
