#!/usr/bin/env node
// CLI wrapper for getSchemaDiff. Prints the SchemaDiffResult JSON to stdout.

import { getSchemaDiff } from "./schema-diff.js";

interface ParsedArgs {
  instance?: string;
  branch?: string;
  comparisonBranch?: string;
  database?: string;
  pretty?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--instance":
        out.instance = argv[++i];
        break;
      case "--branch":
        out.branch = argv[++i];
        break;
      case "--comparison-branch":
      case "--against":
        out.comparisonBranch = argv[++i];
        break;
      case "--database":
        out.database = argv[++i];
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

const HELP = `lakebase-schema-diff – parent-aware schema diff between two Lakebase branches

Usage:
  lakebase-schema-diff --instance <id> --branch <name> [--against <parent>] [--database <db>] [--pretty]

Behavior:
  When --against is omitted, the comparison branch is resolved from Lakebase
  metadata: the target's sourceBranchId (its parent), falling back to the
  project's default branch.

Output:
  JSON on stdout. Shape matches the extension's SchemaDiffResult so the
  modal/webview can consume identical JSON from either call site.

Flags:
  --instance           Lakebase project id (required)
  --branch             Target branch to diff FOR (required)
  --against / --comparison-branch
                       Explicit parent branch (default: resolved from metadata)
  --database           Database name (default: $PGDATABASE or "databricks_postgres")
  --pretty             Pretty-print the JSON output (default: minified)

Examples:
  lakebase-schema-diff --instance proj-abc --branch br-feature
  lakebase-schema-diff --instance proj-abc --branch br-feature --against br-staging --pretty
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.instance) {
    process.stderr.write("Error: --instance is required.\n");
    return 2;
  }
  if (!args.branch) {
    process.stderr.write("Error: --branch is required.\n");
    return 2;
  }

  const result = await getSchemaDiff({
    instance: args.instance,
    branch: args.branch,
    comparisonBranch: args.comparisonBranch,
    database: args.database,
  });

  process.stdout.write(
    args.pretty ? JSON.stringify(result, null, 2) + "\n" : JSON.stringify(result) + "\n"
  );
  return result.error ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
