// Hermetic coverage for the lakebase-detect-language CLI (FEIP-7096).
//
// The CLI is a thin wrapper over migrate.ts's detectLanguage(projectDir),
// added so scaffolded pr.yml + merge.yml can route detection through
// substrate (single source of truth) rather than inlining the marker-file
// shell each time. These tests exercise the CLI surface itself: argv
// parsing, stdout output shape, exit codes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "..", "scripts", "lakebase", "detect-language.cli.ts");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-detect-lang-"));
  tmpDirs.push(dir);
  return dir;
}

function runCli(projectDir: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      "npx",
      ["--yes", "tsx", CLI, "--project-dir", projectDir],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { stdout, stderr: "", status: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      status: e.status ?? 1,
    };
  }
}

describe("lakebase-detect-language CLI", () => {
  it("prints 'java' when pom.xml is present", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>");
    const r = runCli(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("java");
  });

  it("prints 'python' when pyproject.toml is present", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "");
    const r = runCli(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("python");
  });

  it("prints 'python' when requirements.txt is present", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "requirements.txt"), "");
    const r = runCli(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("python");
  });

  it("prints 'nodejs' when only package.json is present", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const r = runCli(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("nodejs");
  });

  it("prioritises pom.xml over package.json (Java + Node mixed)", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>");
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const r = runCli(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("java");
  });

  it("exits non-zero with a stderr message when no marker is present", () => {
    const dir = mkTmp();
    const r = runCli(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/lakebase-detect-language/);
  });
});
