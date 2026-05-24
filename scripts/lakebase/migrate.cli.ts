#!/usr/bin/env node
// CLI for the migrate primitives (FEIP-7091). Four subcommands:
//   lakebase-migrate apply    --instance <id> --branch <name> [...]
//   lakebase-migrate rollback --instance <id> --branch <name> --target <rev> [...]
//   lakebase-migrate status   --instance <id> --branch <name> [...]
//   lakebase-migrate list     [--project-dir <dir>] [--language <lang>]
//
// Prints JSON on stdout, progress on stderr.

import {
  applyMigrations,
  listMigrations,
  migrationStatus,
  rollbackMigration,
  type MigrationLanguage,
} from "./migrate.js";

interface ParsedArgs {
  subcommand?: string;
  instance?: string;
  branch?: string;
  target?: string;
  projectDir?: string;
  language?: MigrationLanguage;
  database?: string;
  endpointName?: string;
  pretty?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  if (argv.length === 0) return out;
  out.subcommand = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--instance":
        out.instance = argv[++i];
        break;
      case "--branch":
        out.branch = argv[++i];
        break;
      case "--target":
        out.target = argv[++i];
        break;
      case "--project-dir":
        out.projectDir = argv[++i];
        break;
      case "--language":
        out.language = argv[++i] as MigrationLanguage;
        break;
      case "--database":
        out.database = argv[++i];
        break;
      case "--endpoint":
      case "--endpoint-name":
        out.endpointName = argv[++i];
        break;
      case "--pretty":
        out.pretty = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

const HELP = `lakebase-migrate (FEIP-7091)

Subcommands:
  apply     Apply pending forward migrations against a branch
  rollback  Roll back applied migrations down to a target version
  status    Show current applied version and pending migrations
  list      Enumerate migration files on disk (no DB connection)

Common flags (for apply, rollback, status):
  --instance <id>            Lakebase project id (required)
  --branch <name>            Branch to migrate against (required)
  --project-dir <dir>        Project root (default: cwd)
  --language <lang>          java | kotlin | python | nodejs (default: auto-detect)
  --database <db>            Database name (default: $PGDATABASE or "databricks_postgres")
  --endpoint <name>          Endpoint identifier on the branch (default: "primary")

Subcommand-specific:
  rollback --target <rev>    Target version to roll back to (required)
  list  --project-dir / --language only

Common flags (any subcommand):
  --pretty                   Pretty-print JSON output

Examples:
  lakebase-migrate list
  lakebase-migrate status --instance proj-x --branch feature/foo
  lakebase-migrate apply --instance proj-x --branch feature/foo
  lakebase-migrate rollback --instance proj-x --branch feature/foo --target -1

Language support today:
  python (alembic)  Full: apply, rollback, status, list
  java, kotlin      list only (apply/rollback/status: FEIP-7098)
  nodejs            list only (apply/rollback/status: FEIP-7099)
`;

function printJson(result: unknown, pretty: boolean): void {
  process.stdout.write(
    (pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n"
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.subcommand) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }

  try {
    switch (args.subcommand) {
      case "list": {
        const result = listMigrations({
          projectDir: args.projectDir,
          language: args.language,
        });
        printJson(result, args.pretty ?? false);
        return 0;
      }
      case "apply": {
        if (!args.instance || !args.branch) {
          process.stderr.write("apply: --instance and --branch are required.\n");
          return 2;
        }
        const result = await applyMigrations({
          instance: args.instance,
          branch: args.branch,
          projectDir: args.projectDir,
          language: args.language,
          database: args.database,
          endpointName: args.endpointName,
        });
        printJson(result, args.pretty ?? false);
        return 0;
      }
      case "rollback": {
        if (!args.instance || !args.branch || !args.target) {
          process.stderr.write("rollback: --instance, --branch, and --target are required.\n");
          return 2;
        }
        const result = await rollbackMigration({
          instance: args.instance,
          branch: args.branch,
          target: args.target,
          projectDir: args.projectDir,
          language: args.language,
          database: args.database,
          endpointName: args.endpointName,
        });
        printJson(result, args.pretty ?? false);
        return 0;
      }
      case "status": {
        if (!args.instance || !args.branch) {
          process.stderr.write("status: --instance and --branch are required.\n");
          return 2;
        }
        const result = await migrationStatus({
          instance: args.instance,
          branch: args.branch,
          projectDir: args.projectDir,
          language: args.language,
          database: args.database,
          endpointName: args.endpointName,
        });
        printJson(result, args.pretty ?? false);
        return 0;
      }
      default:
        process.stderr.write(`Unknown subcommand: ${args.subcommand}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
