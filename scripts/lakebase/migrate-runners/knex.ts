// Knex runner for Node.js projects. Stub for FEIP-7099.
//
// Listing migrations from disk already works via listMigrations() in
// migrate.ts which scans ./migrations/*.{js,ts}. Applying, rolling
// back, and reading status against a real Lakebase branch is deferred
// to FEIP-7099.

import {
  MigrationError,
  type ApplyMigrationsResult,
  type RollbackMigrationResult,
  type MigrationStatusResult,
} from "../migrate.js";

const NOT_IMPLEMENTED =
  "Knex runner not yet implemented in the kit primitive. " +
  "Shell out to `npx knex migrate:latest` / `migrate:rollback` / `migrate:status` " +
  "directly against the branch DSN for now. Tracking ticket: FEIP-7099.";

interface KnexCtx {
  projectDir: string;
  dsn: string;
}

export async function applyKnex(_ctx: KnexCtx): Promise<ApplyMigrationsResult> {
  throw new MigrationError(NOT_IMPLEMENTED);
}

export async function rollbackKnex(_ctx: KnexCtx & { target: string }): Promise<RollbackMigrationResult> {
  throw new MigrationError(NOT_IMPLEMENTED);
}

export async function statusKnex(_ctx: KnexCtx): Promise<MigrationStatusResult> {
  throw new MigrationError(NOT_IMPLEMENTED);
}
