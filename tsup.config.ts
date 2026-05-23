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
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
