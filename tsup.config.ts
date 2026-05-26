import { defineConfig } from "tsup";

// Dual-format build: emit both ESM (.js, since package.json type=module) and
// CJS (.cjs) so the lakebase-scm-extension (CommonJS + webpack) can consume
// without ESM-interop pain on default imports of CJS deps like tweetsodium.
//
// Output structure mirrors the source so the package.json exports map keeps
// stable paths like ./dist/scripts/lakebase/index.{js,cjs}.

export default defineConfig({
  entry: {
    "scripts/index": "scripts/index.ts",
    "scripts/github/index": "scripts/github/index.ts",
    "scripts/lakebase/index": "scripts/lakebase/index.ts",
    "scripts/git/index": "scripts/git/index.ts",
    "scripts/util/index": "scripts/util/index.ts",
    "scripts/github/auth.cli": "scripts/github/auth.cli.ts",
    "scripts/lakebase/get-connection.cli": "scripts/lakebase/get-connection.cli.ts",
    "scripts/lakebase/schema-diff.cli": "scripts/lakebase/schema-diff.cli.ts",
    "scripts/lakebase/create-project.cli": "scripts/lakebase/create-project.cli.ts",
    "scripts/lakebase/migrate.cli": "scripts/lakebase/migrate.cli.ts",
    "scripts/lakebase/cut-backup.cli": "scripts/lakebase/cut-backup.cli.ts",
    "scripts/lakebase/detect-language.cli": "scripts/lakebase/detect-language.cli.ts",
    "apps/mcp-server/index": "apps/mcp-server/index.ts",
    "apps/mcp-server/dump-tools": "apps/mcp-server/dump-tools.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // `shims: true` makes esbuild inject pathToFileURL(__filename).href for
  // `import.meta.url` in the CJS build (and the inverse for ESM). Without
  // it, `import.meta.url` is undefined at runtime in the CJS bundle, which
  // breaks scaffold.ts's findTemplatesDir + sibling helpers when called
  // from a CJS consumer like lakebase-scm-extension. Required for dual-
  // format reach.
  shims: true,
});
