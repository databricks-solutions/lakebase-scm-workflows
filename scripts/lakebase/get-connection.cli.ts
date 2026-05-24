#!/usr/bin/env node
// Thin CLI wrapper around getConnection. Only --output dsn is supported on
// the CLI: pools are JS objects and can't be serialized to stdout. JS
// callers should `import { getConnection }` directly.

import { getConnection } from "./get-connection.js";

interface ParsedArgs {
  output?: string;
  instance?: string;
  branch?: string;
  endpointName?: string;
  database?: string;
  json?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--output":
        out.output = argv[++i];
        break;
      case "--instance":
        out.instance = argv[++i];
        break;
      case "--branch":
        out.branch = argv[++i];
        break;
      case "--endpoint":
      case "--endpoint-name":
        out.endpointName = argv[++i];
        break;
      case "--database":
        out.database = argv[++i];
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        // unknown flag, ignore (lets callers pass through env-only invocations)
        break;
    }
  }
  return out;
}

const HELP = `lakebase-get-connection, credential-handoff helper for Lakebase-paired projects

Usage:
  lakebase-get-connection --output dsn --instance <id> --branch <name> [--endpoint primary] [--database <db>] [--json]

Flags:
  --output    "dsn" (only CLI-supported output). For pg.Pool callers, import
              { getConnection } from "@databricks-solutions/lakebase-app-dev-kit"
              and call with output: "pool", pools are not serializable to stdout.
  --instance  Lakebase project id (required)
  --branch    Branch id within the project (required)
  --endpoint  Endpoint identifier on the branch (default: "primary")
  --database  Database name (default: $PGDATABASE or "databricks_postgres")
  --json      Print the full DsnResult JSON instead of just the URL string

Examples:
  lakebase-get-connection --output dsn --instance proj-abc --branch br-feature
  psql "$(lakebase-get-connection --output dsn --instance proj-abc --branch br-feature)"
  flyway -url="$(lakebase-get-connection --output dsn ...)" migrate
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.output === "pool") {
    process.stderr.write(
      "Error: --output pool is not supported on the CLI (pg.Pool is a runtime object).\n" +
        'Use the module API instead: import { getConnection } from "@databricks-solutions/lakebase-app-dev-kit"\n'
    );
    return 2;
  }
  if (args.output !== "dsn") {
    process.stderr.write(`Error: --output must be "dsn" (got: ${args.output ?? "<missing>"}).\n\n${HELP}`);
    return 2;
  }
  if (!args.instance) {
    process.stderr.write("Error: --instance is required.\n");
    return 2;
  }
  if (!args.branch) {
    process.stderr.write("Error: --branch is required.\n");
    return 2;
  }

  const result = await getConnection({
    output: "dsn",
    instance: args.instance,
    branch: args.branch,
    endpointName: args.endpointName,
    database: args.database,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(result.url + "\n");
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
