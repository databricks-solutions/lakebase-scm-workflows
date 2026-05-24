// Schema migration primitives for Lakebase-paired projects (FEIP-7091).
//
// Four canonical operations:
//   applyMigrations    – run pending forward migrations against a branch
//   rollbackMigration  – undo applied migrations down to a target version
//   migrationStatus    – report current applied version + pending migrations
//   listMigrations     – enumerate available migration files (no DB needed)
//
// Language dispatch: Python/Alembic ships as the reference implementation.
// Java+Kotlin/Flyway (FEIP-7098) and Node/Knex (FEIP-7099) are stubbed; the
// runners throw a clear "not yet implemented" error pointing at the
// follow-up tickets. listMigrations() works for all three languages today
// since it is a pure file-scan with no DB or runtime dependency.
//
// All primitives take explicit {instance, branch} args so headless agents
// (Claude Desktop, OpenAI Codex, CI) can call them without a project .env.
// When called from a checked-out paired project, the project's own .env is
// not consulted by these primitives, only the args passed in.

import * as fs from "node:fs";
import * as path from "node:path";
import { getConnection } from "./get-connection.js";
import { applyAlembic, rollbackAlembic, statusAlembic } from "./migrate-runners/alembic.js";
import { applyFlyway, rollbackFlyway, statusFlyway } from "./migrate-runners/flyway.js";
import { applyKnex, rollbackKnex, statusKnex } from "./migrate-runners/knex.js";

export type MigrationLanguage = "java" | "kotlin" | "python" | "nodejs";

export type MigrationToolName = "flyway" | "alembic" | "knex";

export interface MigrationFile {
  /** Stable identifier sortable in apply-order: Flyway `V<n>`, Alembic
   *  revision hash, Knex timestamp prefix. */
  version: string;
  filename: string;
  description: string;
  type: "SQL" | "Python" | "JavaScript" | "TypeScript";
  /** Tool that should run this file. */
  tool: MigrationToolName;
}

export interface ListMigrationsArgs {
  /** Project root. Defaults to process.cwd(). */
  projectDir?: string;
  /** Override language detection. Defaults to auto-detect from project files. */
  language?: MigrationLanguage;
}

export interface AppliedMigration {
  version: string;
  description: string;
  executionTimeMs?: number;
}

export interface ApplyMigrationsArgs {
  instance: string;
  branch: string;
  projectDir?: string;
  language?: MigrationLanguage;
  database?: string;
  endpointName?: string;
}

export interface ApplyMigrationsResult {
  applied: AppliedMigration[];
  alreadyAtLatest: boolean;
  tool: MigrationToolName;
}

export interface RollbackMigrationArgs {
  instance: string;
  branch: string;
  /** Target version or revision to roll back to. For Alembic this can be a
   *  revision identifier ("ae103…") or a relative step ("-1"). */
  target: string;
  projectDir?: string;
  language?: MigrationLanguage;
  database?: string;
  endpointName?: string;
}

export interface RollbackMigrationResult {
  rolledBack: AppliedMigration[];
  tool: MigrationToolName;
}

export interface MigrationStatusArgs {
  instance: string;
  branch: string;
  projectDir?: string;
  language?: MigrationLanguage;
  database?: string;
  endpointName?: string;
}

export interface PendingMigration {
  version: string;
  filename: string;
  description: string;
}

export interface MigrationStatusResult {
  current: string | undefined;
  pending: PendingMigration[];
  tool: MigrationToolName;
}

export class MigrationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MigrationError";
  }
}

// ---- Language detection --------------------------------------------------

/** Detect the project language from filesystem markers. Mirrors the
 *  detection in templates/project/common/scripts/flyway-migrate.sh so the
 *  kit primitive and the bundled hook agree on which tool to run. */
export function detectLanguage(projectDir: string): MigrationLanguage {
  if (fs.existsSync(path.join(projectDir, "pom.xml"))) {
    // pom.xml present, default to "java"; kotlin still uses pom + Flyway.
    return "java";
  }
  if (
    fs.existsSync(path.join(projectDir, "pyproject.toml")) ||
    fs.existsSync(path.join(projectDir, "requirements.txt")) ||
    fs.existsSync(path.join(projectDir, "alembic.ini"))
  ) {
    return "python";
  }
  if (fs.existsSync(path.join(projectDir, "package.json"))) {
    return "nodejs";
  }
  throw new MigrationError(
    `Could not detect project language in ${projectDir}. ` +
      `Expected one of: pom.xml (java/kotlin), pyproject.toml or alembic.ini (python), package.json (nodejs). ` +
      `Pass {language} explicitly to override.`
  );
}

/** Map a language to the migration tool the kit invokes for it. */
export function toolForLanguage(language: MigrationLanguage): MigrationToolName {
  switch (language) {
    case "java":
    case "kotlin":
      return "flyway";
    case "python":
      return "alembic";
    case "nodejs":
      return "knex";
  }
}

// ---- listMigrations: pure file-scan (works for all three languages) ------

/** Enumerate migration files in a project. No DB connection required.
 *  Order is apply-order (V1, V2, ... for Flyway; chronological for Alembic
 *  via alembic.ini-resolved order; timestamp-ascending for Knex). */
export function listMigrations(args: ListMigrationsArgs = {}): MigrationFile[] {
  const projectDir = args.projectDir ?? process.cwd();
  const language = args.language ?? detectLanguage(projectDir);
  const tool = toolForLanguage(language);

  switch (tool) {
    case "flyway":
      return listFlywayMigrations(projectDir);
    case "alembic":
      return listAlembicMigrations(projectDir);
    case "knex":
      return listKnexMigrations(projectDir);
  }
}

function listFlywayMigrations(projectDir: string): MigrationFile[] {
  // Flyway convention: src/main/resources/db/migration/V<n>__<desc>.sql
  const dir = path.join(projectDir, "src", "main", "resources", "db", "migration");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^V\d+(\.\d+)*__.+\.sql$/.test(f));
  return files
    .map((filename) => {
      const m = filename.match(/^V(\d+(?:\.\d+)*)__(.+)\.sql$/);
      // Detection regex above ensures m is non-null.
      const version = m![1];
      const description = m![2].replace(/_/g, " ");
      return { version, filename, description, type: "SQL" as const, tool: "flyway" as const };
    })
    .sort((a, b) => versionCompare(a.version, b.version));
}

function listAlembicMigrations(projectDir: string): MigrationFile[] {
  // Alembic convention: <alembic-dir>/versions/*.py
  // We support both `migrations/versions/` and `alembic/versions/`.
  const candidates = [
    path.join(projectDir, "migrations", "versions"),
    path.join(projectDir, "alembic", "versions"),
  ];
  const dir = candidates.find((p) => fs.existsSync(p));
  if (!dir) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".py") && !f.startsWith("__"));
  // Alembic files are named <revid>_<slug>.py – slug is the description.
  // True apply-order needs to parse `down_revision = '...'` chains, but for
  // listing purposes the substring before `_` (the revid) plus mtime gives
  // a usable stable order. Real ordering is enforced by Alembic at apply
  // time via its DAG, not by our file listing.
  return files
    .map((filename) => {
      const stem = filename.replace(/\.py$/, "");
      const sep = stem.indexOf("_");
      const version = sep === -1 ? stem : stem.slice(0, sep);
      const description = sep === -1 ? "" : stem.slice(sep + 1).replace(/_/g, " ");
      return { version, filename, description, type: "Python" as const, tool: "alembic" as const };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

function listKnexMigrations(projectDir: string): MigrationFile[] {
  // Knex convention: ./migrations/*.{js,ts} with timestamp prefix.
  const dir = path.join(projectDir, "migrations");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => (f.endsWith(".js") || f.endsWith(".ts")) && !f.startsWith("."));
  return files
    .map((filename) => {
      const stem = filename.replace(/\.(js|ts)$/, "");
      const m = stem.match(/^(\d{14})_(.+)$/);
      const version = m ? m[1] : stem;
      const description = m ? m[2].replace(/[_-]/g, " ") : stem;
      const type = filename.endsWith(".ts") ? ("TypeScript" as const) : ("JavaScript" as const);
      return { version, filename, description, type, tool: "knex" as const };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** Compare Flyway-style version strings: "1", "2", "1.2", "1.2.3". */
function versionCompare(a: string, b: string): number {
  const ax = a.split(".").map(Number);
  const bx = b.split(".").map(Number);
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const av = ax[i] ?? 0;
    const bv = bx[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ---- DSN helper ----------------------------------------------------------

/** Build a Postgres DSN for the target branch. Used by every runner. */
async function dsnFor(args: {
  instance: string;
  branch: string;
  database?: string;
  endpointName?: string;
}): Promise<string> {
  const result = await getConnection({
    output: "dsn",
    instance: args.instance,
    branch: args.branch,
    database: args.database,
    endpointName: args.endpointName,
  });
  return result.url;
}

// ---- applyMigrations -----------------------------------------------------

export async function applyMigrations(args: ApplyMigrationsArgs): Promise<ApplyMigrationsResult> {
  const projectDir = args.projectDir ?? process.cwd();
  const language = args.language ?? detectLanguage(projectDir);
  const tool = toolForLanguage(language);
  const dsn = await dsnFor(args);

  switch (tool) {
    case "alembic":
      return applyAlembic({ projectDir, dsn });
    case "flyway":
      return applyFlyway({ projectDir, dsn });
    case "knex":
      return applyKnex({ projectDir, dsn });
  }
}

// ---- rollbackMigration ---------------------------------------------------

export async function rollbackMigration(args: RollbackMigrationArgs): Promise<RollbackMigrationResult> {
  const projectDir = args.projectDir ?? process.cwd();
  const language = args.language ?? detectLanguage(projectDir);
  const tool = toolForLanguage(language);
  const dsn = await dsnFor(args);

  switch (tool) {
    case "alembic":
      return rollbackAlembic({ projectDir, dsn, target: args.target });
    case "flyway":
      return rollbackFlyway({ projectDir, dsn, target: args.target });
    case "knex":
      return rollbackKnex({ projectDir, dsn, target: args.target });
  }
}

// ---- migrationStatus -----------------------------------------------------

export async function migrationStatus(args: MigrationStatusArgs): Promise<MigrationStatusResult> {
  const projectDir = args.projectDir ?? process.cwd();
  const language = args.language ?? detectLanguage(projectDir);
  const tool = toolForLanguage(language);
  const dsn = await dsnFor(args);

  switch (tool) {
    case "alembic":
      return statusAlembic({ projectDir, dsn });
    case "flyway":
      return statusFlyway({ projectDir, dsn });
    case "knex":
      return statusKnex({ projectDir, dsn });
  }
}
