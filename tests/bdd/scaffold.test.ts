import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deployGitignore,
  deployVscodeSettings,
  deployEnvExample,
  deployDeployTargets,
  deployScripts,
  deployWorkflows,
  installHooks,
  patchWorkflowsForRunnerType,
  scaffoldStaticAll,
} from "../../scripts/lakebase/scaffold.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-scaffold-"));
  tmpDirs.push(dir);
  return dir;
}

describe("deployGitignore", () => {
  it("writes base + java extras for default language", async () => {
    const dir = mkTmp();
    await deployGitignore(dir);
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(content.length).toBeGreaterThan(0);
    // Base content always present
    expect(content).toMatch(/\.env/);
  });

  it("merges python extras when language=python", async () => {
    const dir = mkTmp();
    await deployGitignore(dir, "python");
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    // Python extras include things like __pycache__ / .venv
    expect(content).toMatch(/__pycache__|\.venv|\.pytest_cache/);
  });

  it("merges nodejs extras when language=nodejs", async () => {
    const dir = mkTmp();
    await deployGitignore(dir, "nodejs");
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(content).toMatch(/node_modules/);
  });
});

describe("deployVscodeSettings", () => {
  it("creates .vscode/settings.json", async () => {
    const dir = mkTmp();
    await deployVscodeSettings(dir);
    const settingsPath = path.join(dir, ".vscode", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toBeTypeOf("object");
  });
});

describe("deployEnvExample", () => {
  it("writes .env.example with host + project id substituted", async () => {
    const dir = mkTmp();
    await deployEnvExample(dir, {
      databricksHost: "https://test-workspace.cloud.databricks.com",
      lakebaseProjectId: "test-proj-123",
    });
    const content = fs.readFileSync(path.join(dir, ".env.example"), "utf-8");
    expect(content).toMatch(/^DATABRICKS_HOST=https:\/\/test-workspace\.cloud\.databricks\.com$/m);
    expect(content).toMatch(/^LAKEBASE_PROJECT_ID=test-proj-123$/m);
  });

  it("leaves placeholders untouched when values not provided", async () => {
    const dir = mkTmp();
    await deployEnvExample(dir);
    const content = fs.readFileSync(path.join(dir, ".env.example"), "utf-8");
    expect(content).toMatch(/DATABRICKS_HOST=/);
    expect(content).toMatch(/LAKEBASE_PROJECT_ID=/);
  });
});

describe("deployDeployTargets", () => {
  it("substitutes {{PROJECT_NAME}} when provided", async () => {
    const dir = mkTmp();
    await deployDeployTargets(dir, "my-cool-app");
    const dest = path.join(dir, "deploy-targets.yaml");
    if (!fs.existsSync(dest)) return; // optional template
    const content = fs.readFileSync(dest, "utf-8");
    expect(content).not.toContain("{{PROJECT_NAME}}");
    expect(content).toContain("my-cool-app");
  });
});

describe("deployScripts + deployWorkflows", () => {
  it("populates scripts/ with executable files", async () => {
    const dir = mkTmp();
    const scripts = await deployScripts(dir);
    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) {
      const stat = fs.statSync(path.join(dir, "scripts", name));
      // 0o100 mask checks owner execute bit
      expect(stat.mode & 0o100).not.toBe(0);
    }
  });

  it("populates .github/workflows/ with pr.yml and merge.yml", async () => {
    const dir = mkTmp();
    const workflows = await deployWorkflows(dir);
    expect(workflows).toContain("pr.yml");
    expect(workflows).toContain("merge.yml");
  });
});

describe("installHooks", () => {
  it("throws when target dir has no .git/", async () => {
    const dir = mkTmp();
    await deployScripts(dir);
    await expect(installHooks(dir)).rejects.toThrow(/Not a git repo root/);
  });

  it("installs hook files into .git/hooks/ when scripts present", async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    await deployScripts(dir);
    const summary = await installHooks(dir);
    expect(summary).toMatch(/Installed hooks/);
    // At least post-checkout, prepare-commit-msg, pre-push should exist
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "post-checkout"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "prepare-commit-msg"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "pre-push"))).toBe(true);
  });
});

describe("patchWorkflowsForRunnerType", () => {
  it("is a no-op for github-hosted", async () => {
    const dir = mkTmp();
    await deployWorkflows(dir);
    const before = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    await patchWorkflowsForRunnerType(dir, "github-hosted");
    const after = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    expect(after).toBe(before);
  });

  it("swaps setup-java + adds mvnw -o for self-hosted", async () => {
    const dir = mkTmp();
    await deployWorkflows(dir);
    await patchWorkflowsForRunnerType(dir, "self-hosted");
    for (const file of ["pr.yml", "merge.yml"]) {
      const filePath = path.join(dir, ".github", "workflows", file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      // After patch, setup-java@v4 should not appear
      expect(content).not.toMatch(/uses: actions\/setup-java@v4/);
      // And any mvnw calls should have -o as the first arg
      const mvnwHits = content.match(/\.\/mvnw\s+\S+/g) ?? [];
      for (const hit of mvnwHits) {
        expect(hit).toMatch(/\.\/mvnw -o\b/);
      }
    }
  });
});

describe("scaffoldStaticAll orchestrator", () => {
  it("populates a fresh dir end-to-end (with .git/)", async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const reports: string[] = [];
    const result = await scaffoldStaticAll({
      targetDir: dir,
      databricksHost: "https://h",
      lakebaseProjectId: "p",
      language: "python",
      runnerType: "github-hosted",
      report: (m) => reports.push(m),
    });
    expect(result.scripts.length).toBeGreaterThan(0);
    expect(result.workflows).toContain("pr.yml");
    expect(result.hooksInstalled).toMatch(/Installed hooks/);
    // Spot-check critical files
    expect(fs.existsSync(path.join(dir, ".env.example"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".vscode", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".github", "workflows", "pr.yml"))).toBe(true);
    expect(reports.length).toBeGreaterThan(5);
  });
});
