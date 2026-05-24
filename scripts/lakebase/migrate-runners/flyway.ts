// Flyway runner for Java + Kotlin projects. Stub for FEIP-7098.
//
// Listing migrations from disk (without DB connection) already works via
// listMigrations() in migrate.ts since it just scans
// src/main/resources/db/migration/V*.sql.
//
// Applying, rolling back, and reading status against a real Lakebase
// branch is deferred to FEIP-7098. The bundled
// templates/project/common/scripts/flyway-migrate.sh still works for
// Java/Kotlin projects via the post-merge hook; the kit-level primitive
// just is not callable for those languages yet.

import {
  MigrationError,
  type ApplyMigrationsResult,
  type RollbackMigrationResult,
  type MigrationStatusResult,
} from "../migrate.js";

const NOT_IMPLEMENTED =
  "Flyway runner not yet implemented in the kit primitive. " +
  "For now use the bundled templates/project/common/scripts/flyway-migrate.sh " +
  "via the post-merge hook, or shell out to `mvn flyway:migrate` directly. " +
  "Tracking ticket: FEIP-7098.";

interface FlywayCtx {
  projectDir: string;
  dsn: string;
}

export async function applyFlyway(_ctx: FlywayCtx): Promise<ApplyMigrationsResult> {
  throw new MigrationError(NOT_IMPLEMENTED);
}

export async function rollbackFlyway(_ctx: FlywayCtx & { target: string }): Promise<RollbackMigrationResult> {
  throw new MigrationError(
    NOT_IMPLEMENTED +
      " Additional caveat: Flyway Community Edition does not support rollback. " +
      "Roll-forward with a compensating migration."
  );
}

export async function statusFlyway(_ctx: FlywayCtx): Promise<MigrationStatusResult> {
  throw new MigrationError(NOT_IMPLEMENTED);
}
