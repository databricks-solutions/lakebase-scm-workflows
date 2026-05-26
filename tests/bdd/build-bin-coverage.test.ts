// FEIP-7142: regression check for the bin/tsup-entry drift that landed
// PR #34's broken alpha.20 cut.
//
// PR #34 (FEIP-7096 PR3) added the `lakebase-detect-language` entry to
// package.json's `bin` map and the source file at
// `scripts/lakebase/detect-language.cli.ts`, but did NOT add the
// matching entry to `tsup.config.ts`. Build emitted nothing for that
// path; npx against the published tag returned "command not found"
// because the bin pointed at a non-existent dist file. Hermetic vitest
// at tests/bdd/detect-language.test.ts ran tsx against source, so the
// gap went green.
//
// This test closes that loop: for every package.json bin entry whose
// path resolves under `./dist/scripts/`, there must be a matching tsup
// `entry` so the build emits the file. The test is hermetic (reads
// files, no build, no network).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function parseTsupEntries(): Map<string, string> {
  // Read tsup.config.ts and extract the literal `entry: { ... }` map.
  // The config is hand-maintained and small; a text scan is sturdier
  // here than a dynamic import (which would couple this test to vitest
  // module resolution + tsup's runtime config evaluation).
  const text = fs.readFileSync(path.join(REPO_ROOT, "tsup.config.ts"), "utf8");
  const entryBlock = text.match(/entry:\s*\{([\s\S]+?)\}\s*,/);
  if (!entryBlock) {
    throw new Error("Could not locate `entry: { ... }` block in tsup.config.ts");
  }
  const entries = new Map<string, string>();
  const lineRe = /"([^"]+)":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(entryBlock[1])) !== null) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

describe("build/bin coverage (FEIP-7142)", () => {
  const pkg = readJson<{ bin?: Record<string, string> }>(
    path.join(REPO_ROOT, "package.json"),
  );
  const tsupEntries = parseTsupEntries();

  it("package.json declares at least one bin", () => {
    expect(pkg.bin && Object.keys(pkg.bin).length > 0).toBe(true);
  });

  it("every script-side bin entry maps to a tsup entry", () => {
    const missing: string[] = [];
    for (const [name, distPath] of Object.entries(pkg.bin ?? {})) {
      // distPath looks like "./dist/scripts/lakebase/detect-language.cli.js"
      // or "./dist/apps/mcp-server/index.js". The tsup entry key for the
      // same file is the same path stripped of the `./dist/` prefix and
      // the `.js` suffix:
      //   ./dist/scripts/lakebase/detect-language.cli.js
      //     -> scripts/lakebase/detect-language.cli
      const m = distPath.match(/^\.\/dist\/(.+)\.js$/);
      if (!m) {
        // Not a script-side bin (e.g., a shell script shim). Skip.
        continue;
      }
      const entryKey = m[1];
      if (!tsupEntries.has(entryKey)) {
        missing.push(`bin "${name}" -> "${distPath}" needs tsup entry "${entryKey}"`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("every tsup entry source file exists on disk", () => {
    const missing: string[] = [];
    for (const [key, src] of tsupEntries) {
      const abs = path.join(REPO_ROOT, src);
      if (!fs.existsSync(abs)) {
        missing.push(`tsup entry "${key}" -> "${src}" not found`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });
});
