#!/usr/bin/env node
// CLI wrapper around resolveGitHubToken / diagnoseGitHubAuth.

import { resolveGitHubToken, diagnoseGitHubAuth } from "./auth.js";

interface ParsedArgs {
  json?: boolean;
  diagnose?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        out.json = true;
        break;
      case "--diagnose":
        out.diagnose = true;
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

const HELP = `lakebase-github-token — unified GitHub token resolver

Usage:
  lakebase-github-token                 print the resolved token on stdout
  lakebase-github-token --json          print { token, source } as JSON
  lakebase-github-token --diagnose      print which auth sources are available
                                        (does NOT reveal the token)

Fallback chain:
  1. GITHUB_TOKEN env var
  2. VS Code authentication.getSession (only inside the extension host)
  3. \`gh auth token\`
  4. Exit 1 with a clear error

Scopes required by Lakebase SCM workflow ops:
  repo, workflow, delete_repo

Examples:
  # Pipe into Octokit:
  GH=$(lakebase-github-token) && curl -H "Authorization: bearer $GH" https://api.github.com/user

  # Check which sources are configured (safe to log):
  lakebase-github-token --diagnose
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.diagnose) {
    const diagnosis = await diagnoseGitHubAuth();
    if (args.json) {
      process.stdout.write(JSON.stringify(diagnosis, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Available sources: ${diagnosis.sources.length ? diagnosis.sources.join(", ") : "(none)"}\n` +
          `Primary: ${diagnosis.primary ?? "(none)"}\n` +
          `Scopes: ${diagnosis.scopes.join(", ")}\n`
      );
    }
    return diagnosis.sources.length > 0 ? 0 : 1;
  }

  const token = await resolveGitHubToken();
  if (args.json) {
    const { primary } = await diagnoseGitHubAuth();
    process.stdout.write(JSON.stringify({ token, source: primary }) + "\n");
  } else {
    process.stdout.write(token + "\n");
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
