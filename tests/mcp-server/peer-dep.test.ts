// Verifies the MCP SDK ships as an optional peer dep, not a regular dep.
// This is what keeps the substrate slim for consumers like
// lakebase-scm-extension that import script functions directly and
// never spawn the MCP server.
//
// Two layers:
//   1. Structural: assert package.json dep-shape is correct (fast).
//   2. Integration: `npm pack` + install into a tmp consumer with
//      --omit=dev, assert @modelcontextprotocol/sdk is NOT in the
//      consumer's top-level node_modules. Gated on PEER_DEP_INTEGRATION=1
//      (the install is slow + chatty for default test runs).

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");
const PKG_PATH = resolve(REPO_ROOT, "package.json");
const MCP_SDK_NAME = "@modelcontextprotocol/sdk";

interface PackageJson {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
}

function readPkg(): PackageJson {
  return JSON.parse(readFileSync(PKG_PATH, "utf8"));
}

describe("MCP SDK dep shape (FEIP-7079)", () => {
  it("MCP SDK is NOT in regular dependencies", () => {
    const pkg = readPkg();
    expect(pkg.dependencies?.[MCP_SDK_NAME]).toBeUndefined();
  });

  it("MCP SDK is in peerDependencies", () => {
    const pkg = readPkg();
    expect(pkg.peerDependencies?.[MCP_SDK_NAME]).toBeDefined();
  });

  it("MCP SDK peer is marked optional via peerDependenciesMeta", () => {
    const pkg = readPkg();
    expect(pkg.peerDependenciesMeta?.[MCP_SDK_NAME]?.optional).toBe(true);
  });

  it("MCP SDK is in devDependencies so the substrate's own build resolves it", () => {
    const pkg = readPkg();
    expect(pkg.devDependencies?.[MCP_SDK_NAME]).toBeDefined();
  });
});

describe.skipIf(!process.env.PEER_DEP_INTEGRATION)(
  "MCP SDK absence in consumer install (integration, slow)",
  () => {
    it("npm install --omit=dev does NOT pull MCP SDK into consumer node_modules", () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "lakebase-peer-check-"));
      try {
        // Skip --json: npm pack runs `prepare` (tsup) and prints its
        // output to stdout, which corrupts JSON parsing. Compute the
        // tarball name from package.json – npm's naming is deterministic:
        // <scope-stripped>-<name>-<version>.tgz.
        const pkg = readPkg() as PackageJson & { name?: string };
        const pkgName = pkg.name ?? "@databricks-solutions/lakebase-app-dev-kit";
        const fileBase = pkgName.replace(/^@/, "").replace(/\//g, "-");
        const tarballName = `${fileBase}-${pkg.version}.tgz`;
        execSync("npm pack --ignore-scripts", {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: "pipe",
        });
        const tgz = resolve(REPO_ROOT, tarballName);
        expect(existsSync(tgz)).toBe(true);

        writeFileSync(
          resolve(tmpDir, "package.json"),
          JSON.stringify(
            {
              name: "lakebase-peer-check-consumer",
              version: "0.0.0",
              private: true,
              dependencies: {
                "@databricks-solutions/lakebase-app-dev-kit": `file:${tgz}`,
              },
            },
            null,
            2
          )
        );

        execSync("npm install --omit=dev --no-audit --no-fund --ignore-scripts", {
          cwd: tmpDir,
          encoding: "utf8",
          stdio: "pipe",
        });

        const consumerNm = resolve(tmpDir, "node_modules");
        expect(existsSync(consumerNm)).toBe(true);
        const mcpDir = resolve(consumerNm, "@modelcontextprotocol");
        expect(
          existsSync(mcpDir),
          `Expected MCP SDK absent from consumer top-level node_modules. Got: ${
            existsSync(mcpDir) ? readdirSync(mcpDir).join(",") : "(absent)"
          }`
        ).toBe(false);

        rmSync(tgz, { force: true });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 120_000);
  }
);
