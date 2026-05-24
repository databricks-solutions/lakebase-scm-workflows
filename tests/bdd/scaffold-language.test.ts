import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deployLanguageProject } from "../../scripts/lakebase/scaffold-language.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-lang-"));
  tmpDirs.push(dir);
  return dir;
}

describe("deployLanguageProject, python path (static copy)", () => {
  it("copies the python template tree into targetDir", async () => {
    const dir = mkTmp();
    await deployLanguageProject({ targetDir: dir, language: "python", projectName: "py-test" });
    // Python template ships app/main.py, pyproject.toml, alembic/, etc.
    expect(fs.existsSync(path.join(dir, "pyproject.toml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "app", "main.py"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "alembic", "env.py"))).toBe(true);
    // Should NOT copy .gitignore.extra (skipped by copyDirSubstituted)
    expect(fs.existsSync(path.join(dir, ".gitignore.extra"))).toBe(false);
  });

  it("substitutes {{PROJECT_NAME}} placeholders", async () => {
    const dir = mkTmp();
    await deployLanguageProject({ targetDir: dir, language: "python", projectName: "my-cool-app" });
    // Spot-check pyproject.toml or any other file with placeholders
    const pyproject = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf-8");
    expect(pyproject).not.toMatch(/\{\{PROJECT_NAME\}\}/);
  });
});

describe("deployLanguageProject, nodejs path", () => {
  it("copies the nodejs template tree into targetDir", async () => {
    const dir = mkTmp();
    await deployLanguageProject({ targetDir: dir, language: "nodejs", projectName: "node-test" });
    expect(fs.existsSync(path.join(dir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "knexfile.js"))).toBe(true);
  });
});

describe("deployLanguageProject, java/kotlin path (Initializr w/ fallback)", () => {
  const originalFlag = process.env.LAKEBASE_SCAFFOLD_FALLBACK;
  beforeEach(() => { process.env.LAKEBASE_SCAFFOLD_FALLBACK = "1"; });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LAKEBASE_SCAFFOLD_FALLBACK;
    else process.env.LAKEBASE_SCAFFOLD_FALLBACK = originalFlag;
  });

  it("routes java -> Spring fallback when flag set", async () => {
    const dir = mkTmp();
    await deployLanguageProject({ targetDir: dir, language: "java", projectName: "java-test" });
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "mvnw"))).toBe(true);
  });

  it("routes kotlin -> Spring fallback when flag set", async () => {
    const dir = mkTmp();
    await deployLanguageProject({ targetDir: dir, language: "kotlin", projectName: "kotlin-test" });
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "mvnw"))).toBe(true);
  });
});
