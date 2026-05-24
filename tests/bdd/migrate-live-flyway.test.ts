// Live integration test for the Flyway migrate runner (FEIP-7098).
//
// Provisions its own Lakebase project on the configured Databricks
// workspace, scaffolds a minimal Maven-style Flyway project layout,
// runs the migrate primitives that Flyway Community Edition supports
// (apply / status / list) against the default branch, verifies via
// pg.Pool that the migration landed, and tears the project down.
//
// Rollback is intentionally NOT exercised: Flyway Community Edition
// does not implement `undo`. The runner throws a clear MigrationError;
// the hermetic test in tests/bdd/migrate.test.ts covers that path.
//
// Gating:
//   LAKEBASE_TEST_E2E=1          must be set; the suite skips otherwise
//   DATABRICKS_HOST              workspace URL to provision against
//   databricks CLI               authenticated to that workspace
//   flyway                       command on PATH (Java 17+ runtime)
//   java                         command on PATH (flyway runs as a JVM tool)

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyMigrations,
  listMigrations,
  migrationStatus,
} from "../../scripts/lakebase/migrate.js";
import { getConnection } from "../../scripts/lakebase/get-connection.js";
import {
  createLakebaseProject,
  deleteLakebaseProject,
} from "../../scripts/lakebase/lakebase-project.js";
import { getDefaultBranch } from "../../scripts/lakebase/branch-utils.js";

const E2E = process.env.LAKEBASE_TEST_E2E === "1";
const DATABRICKS_HOST = process.env.DATABRICKS_HOST ?? "";

function hasCmd(cmd: string): boolean {
  const res = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return res.status === 0;
}
const FLYWAY_AVAILABLE = E2E ? hasCmd("flyway") : false;
const JAVA_AVAILABLE = E2E ? hasCmd("java") : false;
const DATABRICKS_AVAILABLE = E2E ? hasCmd("databricks") : false;

const RUN_SUITE = E2E && DATABRICKS_HOST && DATABRICKS_AVAILABLE && FLYWAY_AVAILABLE && JAVA_AVAILABLE;

describe.skipIf(!RUN_SUITE)(
  "migrate live (flyway against a freshly-provisioned Lakebase project)",
  () => {
    let projectDir: string;
    let projectId: string;
    let branchName: string;
    let tableName: string;

    beforeAll(async () => {
      projectId = `migrate-7098-${Date.now()}`;
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `migrate-flyway-live-${projectId}-`));
      tableName = `flyway_e2e_${Date.now()}`;
      scaffoldFlywayProject(projectDir, tableName);

      console.log(`  [setup] creating Lakebase project ${projectId} on ${DATABRICKS_HOST}`);
      await createLakebaseProject({ projectId, host: DATABRICKS_HOST });

      const dflt = await getDefaultBranch({ instance: projectId, host: DATABRICKS_HOST });
      if (!dflt) {
        throw new Error(
          `Project ${projectId} has no default branch after creation. Check workspace + permissions.`
        );
      }
      const fullName = dflt.name ?? "";
      branchName = fullName.split("/branches/").pop() ?? dflt.uid;
      console.log(`  [setup] default branch: ${branchName}`);
    }, 180_000);

    afterAll(async () => {
      if (projectId) {
        try {
          const pool = await getConnection({
            output: "pool",
            instance: projectId,
            branch: branchName,
          });
          await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
          await pool.query(`DROP TABLE IF EXISTS flyway_schema_history`);
          await pool.end();
        } catch {
          // Best effort; project delete below removes everything anyway.
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await deleteLakebaseProject({ projectId, host: DATABRICKS_HOST });
            console.log(`  [teardown] deleted Lakebase project ${projectId}`);
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/not.?found/i.test(msg)) break;
            if (attempt === 3) {
              console.error(`  [teardown] FAILED to delete ${projectId}: ${msg}`);
              console.error(
                `  [teardown] clean up manually: databricks postgres delete-project ${projectId}`
              );
            } else {
              await new Promise((r) => setTimeout(r, 5_000 * attempt));
            }
          }
        }
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }, 240_000);

    it("listMigrations enumerates the scaffolded V1 migration", () => {
      const files = listMigrations({ projectDir });
      expect(files).toHaveLength(1);
      expect(files[0].tool).toBe("flyway");
      expect(files[0].version).toBe("1");
      expect(files[0].description.toLowerCase().includes("init")).toBe(true);
    });

    it("migrationStatus reports current=undefined and one pending before apply", async () => {
      const status = await migrationStatus({
        instance: projectId,
        branch: branchName,
        projectDir,
      });
      expect(status.tool).toBe("flyway");
      expect(status.current).toBeUndefined();
      expect(status.pending.some((p) => p.version === "1")).toBe(true);
    }, 60_000);

    it("applyMigrations applies the pending V1; table exists in DB", async () => {
      const result = await applyMigrations({
        instance: projectId,
        branch: branchName,
        projectDir,
      });
      expect(result.tool).toBe("flyway");
      expect(result.applied.some((a) => a.version === "1")).toBe(true);

      const pool = await getConnection({
        output: "pool",
        instance: projectId,
        branch: branchName,
      });
      try {
        const { rows } = await pool.query(`SELECT to_regclass($1) AS oid`, [tableName]);
        expect(rows[0].oid).not.toBeNull();
      } finally {
        await pool.end();
      }
    }, 180_000);

    it("migrationStatus reports current=1 and no pending after apply", async () => {
      const status = await migrationStatus({
        instance: projectId,
        branch: branchName,
        projectDir,
      });
      expect(status.current).toBe("1");
      expect(status.pending.some((p) => p.version === "1")).toBe(false);
    }, 60_000);
  }
);

/** Lay down a minimal self-contained Flyway-compatible project: a stub
 *  pom.xml (so detectLanguage() returns "java") plus one SQL migration
 *  under the standard Flyway location. */
function scaffoldFlywayProject(dir: string, tableName: string): void {
  fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>\n");

  const migrationsDir = path.join(dir, "src", "main", "resources", "db", "migration");
  fs.mkdirSync(migrationsDir, { recursive: true });

  fs.writeFileSync(
    path.join(migrationsDir, `V1__init_${tableName}.sql`),
    `CREATE TABLE ${tableName} (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
  );
}
