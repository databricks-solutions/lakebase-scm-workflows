#!/usr/bin/env node
// CLI wrapper around createProject. Supports two input modes:
//   --json-input '<json>'  — single JSON arg with all CreateProjectArgs
//   <named flags>          — individual --project-name, --parent-dir, etc.
//
// Output: JSON to stdout containing CreateProjectResult. Progress goes to
// stderr.

import { createProject, CreateProjectArgs } from "./create-project.js";

interface ParsedArgs {
  jsonInput?: string;
  projectName?: string;
  parentDir?: string;
  databricksHost?: string;
  githubOwner?: string;
  createGithubRepo?: boolean;
  privateRepo?: boolean;
  language?: "java" | "kotlin" | "python" | "nodejs";
  runnerType?: "self-hosted" | "github-hosted";
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json-input":
        out.jsonInput = argv[++i];
        break;
      case "--project-name":
        out.projectName = argv[++i];
        break;
      case "--parent-dir":
        out.parentDir = argv[++i];
        break;
      case "--databricks-host":
        out.databricksHost = argv[++i];
        break;
      case "--github-owner":
        out.githubOwner = argv[++i];
        break;
      case "--no-github":
        out.createGithubRepo = false;
        break;
      case "--public":
        out.privateRepo = false;
        break;
      case "--language":
        out.language = argv[++i] as ParsedArgs["language"];
        break;
      case "--runner":
        out.runnerType = argv[++i] as ParsedArgs["runnerType"];
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

const HELP = `lakebase-create-project — bootstrap a fresh Lakebase-paired project

Usage:
  lakebase-create-project --project-name <name> --parent-dir <dir> --databricks-host <url> [--github-owner <owner>] [flags...]
  lakebase-create-project --json-input '{"projectName": "...", ...}'

Flags:
  --project-name      Project name (Lakebase id + local dir name)            [required]
  --parent-dir        Parent directory for the new project                   [required]
  --databricks-host   Databricks workspace URL                               [required]
  --github-owner      GitHub user/org for the repo                           [required unless --no-github]
  --no-github         Skip GitHub repo creation (local-only)
  --public            Make the GitHub repo public (default: private)
  --language          java | kotlin | python | nodejs    (default: java)
  --runner            self-hosted | github-hosted        (default: self-hosted)
  --json-input        Pass all args as a single JSON object (BDD harness)

Output: JSON on stdout (CreateProjectResult). Progress to stderr.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let input: CreateProjectArgs;
  if (args.jsonInput) {
    try {
      input = JSON.parse(args.jsonInput) as CreateProjectArgs;
    } catch (err) {
      process.stderr.write(`Failed to parse --json-input: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  } else {
    if (!args.projectName || !args.parentDir || !args.databricksHost) {
      process.stderr.write("Error: --project-name, --parent-dir, --databricks-host are required.\n\n" + HELP);
      return 2;
    }
    input = {
      projectName: args.projectName,
      parentDir: args.parentDir,
      databricksHost: args.databricksHost,
      githubOwner: args.githubOwner,
      createGithubRepo: args.createGithubRepo,
      privateRepo: args.privateRepo,
      language: args.language,
      runnerType: args.runnerType,
    };
  }

  const result = await createProject(input, (step, detail) => {
    process.stderr.write(`[${step}]${detail ? ` ${detail}` : ""}\n`);
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
