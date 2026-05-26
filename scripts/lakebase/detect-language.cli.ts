#!/usr/bin/env node
// CLI for substrate's project-language detector. Used by the scaffolded
// pr.yml + merge.yml to populate `steps.detect-lang.outputs.lang` without
// duplicating the detection bash inline.
//
// Output: prints "java" | "python" | "nodejs" to stdout. Exits non-zero
// if no recognised marker file is present.
//
// Optional flag: --project-dir <path> (defaults to cwd).
//
// GitHub Actions usage (matches the migrate + cut-backup CLIs pinned at
// scaffold time via {{LAKEBASE_KIT_VERSION}}):
//
//   - name: Detect project language
//     id: detect-lang
//     run: |
//       LANG="$(npx --yes \
//         --package=github:databricks-solutions/lakebase-app-dev-kit#v<pin> \
//         lakebase-detect-language)"
//       echo "lang=$LANG" >> $GITHUB_OUTPUT

import { detectLanguage } from "./migrate.js";

function parseProjectDir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project-dir" && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (argv[i] === "-h" || argv[i] === "--help") {
      printHelpAndExit();
    }
  }
  return process.cwd();
}

function printHelpAndExit(): never {
  process.stdout.write(
    `lakebase-detect-language — print the project's language\n\n` +
      `Usage:\n` +
      `  lakebase-detect-language [--project-dir <path>]\n\n` +
      `Output (stdout): one of "java", "python", "nodejs"\n` +
      `Exits 1 with an error message on stderr if no marker found.\n`,
  );
  process.exit(0);
}

const projectDir = parseProjectDir(process.argv.slice(2));

try {
  const lang = detectLanguage(projectDir);
  process.stdout.write(`${lang}\n`);
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lakebase-detect-language: ${msg}\n`);
  process.exit(1);
}
