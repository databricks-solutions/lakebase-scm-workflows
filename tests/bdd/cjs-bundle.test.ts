import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// REGRESSION GUARD: when tsup bundles ESM source to CJS, `import.meta.url` is
// undefined at CJS runtime unless `shims: true` is set in tsup.config.ts.
// The substrate's findTemplatesDir uses fileURLToPath(import.meta.url) to
// locate its own templates/ directory; without the shim, every scaffold
// operation from a CJS consumer (e.g. lakebase-scm-extension via webpack)
// crashes inside the substrate.
//
// Vitest runs source files in ESM mode, so unit tests against the source
// CANNOT catch this — the bug only shows up against the built CJS bundle.
// This test exercises the CJS bundle directly and was added in response to
// the python-devloop integration test discovering the regression. The fix
// is `shims: true` in tsup.config.ts.

const DIST_CJS = path.resolve(__dirname, "../../dist/scripts/lakebase/index.cjs");
const distExists = fs.existsSync(DIST_CJS);

describe.skipIf(!distExists)("CJS bundle — import.meta.url shim works (tsup shims: true)", () => {
  it("deployVscodeSettings resolves templates dir without crashing", () => {
    // deployVscodeSettings → templatesRoot → findTemplatesDir → fileURLToPath(import.meta.url)
    // If the shim is missing, findTemplatesDir throws TypeError("path must be string").
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-cjs-bundle-"));
    try {
      const script = `
        const { deployVscodeSettings } = require(${JSON.stringify(DIST_CJS)});
        (async () => {
          await deployVscodeSettings(${JSON.stringify(tmpDir)});
          console.log("ok");
        })().catch(e => { console.error(e.message); process.exit(1); });
      `;
      const result = execFileSync("node", ["-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      expect(result.trim()).toBe("ok");
      expect(fs.existsSync(path.join(tmpDir, ".vscode", "settings.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deployGitignore (calls templatesRoot via different path) also resolves", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-cjs-bundle-"));
    try {
      const script = `
        const { deployGitignore } = require(${JSON.stringify(DIST_CJS)});
        (async () => {
          await deployGitignore(${JSON.stringify(tmpDir)}, "java");
          console.log("ok");
        })().catch(e => { console.error(e.message); process.exit(1); });
      `;
      const result = execFileSync("node", ["-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      expect(result.trim()).toBe("ok");
      expect(fs.existsSync(path.join(tmpDir, ".gitignore"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scaffold-language and spring-initializr modules load without crashing", () => {
    // These two other modules also use fileURLToPath(import.meta.url) and would
    // crash at load-time if the shim regressed.
    const script = `
      const m = require(${JSON.stringify(DIST_CJS)});
      // Touch the symbols so any lazy initialization runs.
      if (typeof m.deployLanguageProject !== "function") throw new Error("missing deployLanguageProject");
      if (typeof m.deploySpringStarter !== "function") throw new Error("missing deploySpringStarter");
      if (typeof m.SpringInitializrClient !== "function") throw new Error("missing SpringInitializrClient");
      console.log("ok");
    `;
    const result = execFileSync("node", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    expect(result.trim()).toBe("ok");
  });
});

describe("CJS bundle — skip-when-missing", () => {
  it("documents the skip reason when dist/scripts/lakebase/index.cjs isn't built", () => {
    if (distExists) return;
    // eslint-disable-next-line no-console
    console.log(
      "dist/scripts/lakebase/index.cjs not found — run `npm run build` to enable the CJS bundle regression guard."
    );
    expect(distExists).toBe(false);
  });
});
