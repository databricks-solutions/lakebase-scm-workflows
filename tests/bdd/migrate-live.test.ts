// Live integration test for the migrate primitives (FEIP-7091).
//
// Provisions its own Lakebase project on the configured Databricks
// workspace, runs the four migrate primitives against the default
// branch, verifies via pg.Pool that the migration landed, and tears
// the project down. Same self-contained pattern as the extension's
// python-devloop integration test.
//
// Gating:
//   LAKEBASE_TEST_E2E=1          must be set; the suite skips otherwise
//   DATABRICKS_HOST              workspace URL to provision against
//                                (e.g. https://<workspace>.cloud.databricks.com)
//   databricks CLI               authenticated to that workspace
//   alembic                      command on PATH (Python + alembic installed)
//
// The Lakebase project is suffixed with a unique timestamp so concurrent
// runs and re-runs do not collide. Teardown deletes the project even on
// failure.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyMigrations,
  listMigrations,
  migrationStatus,
  rollbackMigration,
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
const ALEMBIC_AVAILABLE = E2E ? hasCmd("alembic") : false;
const DATABRICKS_AVAILABLE = E2E ? hasCmd("databricks") : false;

const RUN_SUITE = E2E && DATABRICKS_HOST && DATABRICKS_AVAILABLE && ALEMBIC_AVAILABLE;

describe.skipIf(!RUN_SUITE)("migrate live (alembic against a freshly-provisioned Lakebase project)", () => {
  let projectDir: string;
  let projectId: string;
  let branchName: string;
  let tableName: string;

  beforeAll(async () => {
    projectId = `migrate-7091-${Date.now()}`;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `migrate-live-${projectId}-`));
    tableName = `migrate_e2e_${Date.now()}`;
    scaffoldAlembicProject(projectDir, tableName);

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
          host: DATABRICKS_HOST,
        });
        await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
        await pool.end();
      } catch {
        // Best effort; the project delete below removes everything anyway.
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
            console.error(`  [teardown] clean up manually: databricks postgres delete-project ${projectId}`);
          } else {
            await new Promise((r) => setTimeout(r, 5_000 * attempt));
          }
        }
      }
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  }, 240_000);

  it("listMigrations enumerates the scaffolded migration", () => {
    const files = listMigrations({ projectDir });
    expect(files).toHaveLength(1);
    expect(files[0].tool).toBe("alembic");
    expect(files[0].description.includes("init")).toBe(true);
  });

  it("migrationStatus reports current=undefined and one pending before apply", async () => {
    const status = await migrationStatus({
      instance: projectId,
      branch: branchName,
      projectDir,
    });
    expect(status.tool).toBe("alembic");
    expect(status.current).toBeUndefined();
    expect(status.pending.some((p) => p.version === "a1b2c3d4e5f6")).toBe(true);
  }, 60_000);

  it("applyMigrations applies the pending migration; table exists in DB", async () => {
    const result = await applyMigrations({
      instance: projectId,
      branch: branchName,
      projectDir,
    });
    expect(result.tool).toBe("alembic");
    expect(result.applied.some((a) => a.version === "a1b2c3d4e5f6")).toBe(true);

    const pool = await getConnection({
      output: "pool",
      instance: projectId,
      branch: branchName,
      host: DATABRICKS_HOST,
    });
    try {
      const { rows } = await pool.query(`SELECT to_regclass($1) AS oid`, [tableName]);
      expect(rows[0].oid).not.toBeNull();
    } finally {
      await pool.end();
    }
  }, 180_000);

  it("migrationStatus reports current=a1b2c3d4e5f6 and no pending after apply", async () => {
    const status = await migrationStatus({
      instance: projectId,
      branch: branchName,
      projectDir,
    });
    expect(status.current).toBe("a1b2c3d4e5f6");
    expect(status.pending.some((p) => p.version === "a1b2c3d4e5f6")).toBe(false);
  }, 60_000);

  it("rollbackMigration rolls back the migration; table is dropped", async () => {
    const result = await rollbackMigration({
      instance: projectId,
      branch: branchName,
      target: "-1",
      projectDir,
    });
    expect(result.tool).toBe("alembic");
    expect(result.rolledBack.length).toBeGreaterThan(0);

    const pool = await getConnection({
      output: "pool",
      instance: projectId,
      branch: branchName,
      host: DATABRICKS_HOST,
    });
    try {
      const { rows } = await pool.query(`SELECT to_regclass($1) AS oid`, [tableName]);
      expect(rows[0].oid).toBeNull();
    } finally {
      await pool.end();
    }
  }, 180_000);
});

/** Lay down a minimal self-contained Alembic project with one migration. */
function scaffoldAlembicProject(dir: string, tableName: string): void {
  fs.writeFileSync(
    path.join(dir, "alembic.ini"),
    [
      "[alembic]",
      "script_location = migrations",
      "sqlalchemy.url = will-be-overridden-by-env-py",
      "",
      "[loggers]",
      "keys = root",
      "[handlers]",
      "keys = console",
      "[formatters]",
      "keys = generic",
      "[logger_root]",
      "level = INFO",
      "handlers = console",
      "qualname =",
      "[handler_console]",
      "class = StreamHandler",
      "args = (sys.stderr,)",
      "level = NOTSET",
      "formatter = generic",
      "[formatter_generic]",
      "format = %(levelname)-5.5s [%(name)s] %(message)s",
      "datefmt = %H:%M:%S",
      "",
    ].join("\n")
  );

  fs.mkdirSync(path.join(dir, "migrations", "versions"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "migrations", "env.py"),
    `import os
from logging.config import fileConfig
from sqlalchemy import create_engine, pool
from alembic import context

# Do NOT route the URL through Alembic's config / configparser. Lakebase
# DSNs contain percent-encoded characters (e.g. '%40' for '@' in the
# OAuth username) which configparser tries to interpolate. Pass the URL
# straight to create_engine to keep alembic away from it.

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
target_metadata = None
DB_URL = os.environ["DATABASE_URL"]

def run_migrations_offline():
    context.configure(
        url=DB_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online():
    connectable = create_engine(DB_URL, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
`
  );

  fs.writeFileSync(
    path.join(dir, "migrations", "versions", `a1b2c3d4e5f6_init_${tableName}.py`),
    `"""init ${tableName}

Revision ID: a1b2c3d4e5f6
Revises:
Create Date: 2026-05-24 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = "a1b2c3d4e5f6"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "${tableName}",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("${tableName}")
`
  );

  fs.writeFileSync(
    path.join(dir, "migrations", "script.py.mako"),
    `"""\${message}

Revision ID: \${up_revision}
Revises: \${down_revision | comma,n}
Create Date: \${create_date}

"""
from alembic import op
import sqlalchemy as sa

revision = \${repr(up_revision)}
down_revision = \${repr(down_revision)}
branch_labels = \${repr(branch_labels)}
depends_on = \${repr(depends_on)}


def upgrade():
    \${upgrades if upgrades else "pass"}


def downgrade():
    \${downgrades if downgrades else "pass"}
`
  );
}
