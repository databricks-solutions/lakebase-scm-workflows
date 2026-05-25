import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

describe("deployWorkflows: {{LAKEBASE_KIT_VERSION}} substitution", () => {
  // Kit version pinning happens at scaffold-time so the generated YAML
  // resolves the substrate via a stable `github:.../#vX.Y.Z` ref. After
  // copy, no scaffolded file should contain the literal placeholder.
  it("substitutes {{LAKEBASE_KIT_VERSION}} in scaffolded pr.yml with the kit's package.json version", async () => {
    const dir = mkTmp();
    await deployWorkflows(dir);
    const prYml = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    expect(prYml).not.toContain("{{LAKEBASE_KIT_VERSION}}");
    // The kit's own package.json version is what gets pinned.
    const kitPkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "package.json"),
        "utf-8"
      )
    ) as { version: string };
    expect(prYml).toContain(`#v${kitPkg.version}`);
  });

  it("scaffolded pr.yml routes migrations through the substrate's lakebase-migrate CLI", async () => {
    const dir = mkTmp();
    await deployWorkflows(dir);
    const prYml = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    // Substrate routing line, not the old language-branched mvnw/uv/npx-knex shape.
    expect(prYml).toMatch(/lakebase-migrate apply/);
    expect(prYml).toMatch(/github:databricks-solutions\/lakebase-app-dev-kit/);
    expect(prYml).toMatch(/--instance "\$LAKEBASE_PROJECT_ID"/);
    expect(prYml).toMatch(/--branch "\$LAKEBASE_BRANCH_NAME"/);
    // The old per-language branches MUST be gone — substrate handles
    // language detection internally.
    expect(prYml).not.toMatch(/flyway:migrate/);
    expect(prYml).not.toMatch(/uv run alembic upgrade head/);
    expect(prYml).not.toMatch(/npx knex migrate:latest/);
  });

  it("scaffolded pr.yml's migrate step passes auth from secrets with DATABRICKS_AUTH_TYPE=pat", async () => {
    // Regression guard: the substrate's lakebase-migrate CLI spawns
    // `databricks postgres list-endpoints` under the hood. On Databricks
    // CLI v1+ that call fails with "stored credentials from older CLI
    // versions are no longer used" unless DATABRICKS_AUTH_TYPE=pat is
    // set in the step env. Pulling DATABRICKS_HOST from `env.X` (which
    // is empty unless a prior step echoed into $GITHUB_ENV) is the trap
    // we want to prevent regressing into.
    const dir = mkTmp();
    await deployWorkflows(dir);
    const prYml = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    // Extract the Run migrations (CI branch) step's env block via a
    // narrow regex - other steps have their own env blocks we don't
    // want to false-match against.
    const migrateBlock = prYml.match(
      /- name: Run migrations \(CI branch\)[\s\S]*?(?=\n\s*- name:|\Z)/,
    );
    expect(migrateBlock, "Run migrations (CI branch) step not found").toBeTruthy();
    const block = migrateBlock![0];
    expect(block).toMatch(/DATABRICKS_HOST:\s*\$\{\{\s*secrets\.DATABRICKS_HOST\s*\}\}/);
    expect(block).toMatch(/DATABRICKS_TOKEN:\s*\$\{\{\s*secrets\.DATABRICKS_TOKEN\s*\}\}/);
    expect(block).toMatch(/DATABRICKS_AUTH_TYPE:\s*pat/);
    // The trap: env.DATABRICKS_HOST (empty unless someone echoed it).
    expect(block).not.toMatch(/DATABRICKS_HOST:\s*\$\{\{\s*env\.DATABRICKS_HOST\s*\}\}/);
  });

  it("scaffolded pr.yml includes the Flyway CLI install step gated on pom.xml", async () => {
    const dir = mkTmp();
    await deployWorkflows(dir);
    const prYml = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    expect(prYml).toMatch(/name: Install Flyway CLI/);
    // Runtime gate: only install on Java/Kotlin projects (pom.xml present).
    expect(prYml).toMatch(/hashFiles\('pom\.xml'\) != ''/);
  });

  it("scaffolded pr.yml's Install Flyway step short-circuits when flyway is on PATH", async () => {
    // Prevents a regression where the step unconditionally curl'd from
    // repo1.maven.org. Internal self-hosted runners often have flyway
    // already on PATH via brew/apt; the kit must use it before reaching
    // out to the network.
    const dir = mkTmp();
    await deployWorkflows(dir);
    const prYml = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    expect(prYml).toMatch(/command -v flyway >\/dev\/null 2>&1/);
    expect(prYml).toMatch(/skipping download/);
  });

  it("scaffolded pr.yml honors FLYWAY_DOWNLOAD_BASE_URL via vars.* and env default", async () => {
    // For runners behind a Maven-proxy mirror (e.g. internal proxies
    // that block repo1.maven.org). The vars.X reference wires the GH
    // Actions repo Variable into the step's env; the bash fallback
    // keeps repo1.maven.org as the default when the var is unset.
    const dir = mkTmp();
    await deployWorkflows(dir);
    const prYml = fs.readFileSync(path.join(dir, ".github", "workflows", "pr.yml"), "utf-8");
    expect(prYml).toMatch(/FLYWAY_DOWNLOAD_BASE_URL:\s*\$\{\{\s*vars\.FLYWAY_DOWNLOAD_BASE_URL\s*\}\}/);
    expect(prYml).toMatch(/FLYWAY_BASE="\$\{FLYWAY_DOWNLOAD_BASE_URL:-https:\/\/repo1\.maven\.org\/maven2\}"/);
  });

  it("falls back to 'unknown' when templatesDir points at a tree without a package.json", async () => {
    // Build a minimal fixture: tmpRoot has only `templates/project/common/.github/workflows/`,
    // no package.json at tmpRoot. kitVersion() resolves via path.dirname twice,
    // so the lookup target is tmpRoot/package.json — which is absent.
    const fixture = mkTmp();
    const templates = path.join(fixture, "templates", "project");
    const wfDir = path.join(templates, "common", ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    // Marker file expected by findTemplatesDir (not consulted when
    // templatesDir is passed explicitly, but cheap to include).
    fs.writeFileSync(path.join(templates, "common", ".gitignore.base"), "");
    fs.writeFileSync(
      path.join(wfDir, "pr.yml"),
      "kit: {{LAKEBASE_KIT_VERSION}}\n"
    );

    const target = mkTmp();
    await deployWorkflows(target, { templatesDir: templates });
    const out = fs.readFileSync(path.join(target, ".github", "workflows", "pr.yml"), "utf-8");
    expect(out).toBe("kit: unknown\n");
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

  it("swaps setup-java for self-hosted and leaves mvnw calls online", async () => {
    const dir = mkTmp();
    await deployWorkflows(dir);
    await patchWorkflowsForRunnerType(dir, "self-hosted");
    for (const file of ["pr.yml", "merge.yml"]) {
      const filePath = path.join(dir, ".github", "workflows", file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      // After patch, setup-java@v4 should not appear (self-hosted runner
      // brings its own JDK; the scaffold swaps to a local JDK step).
      expect(content).not.toMatch(/uses: actions\/setup-java@v4/);
      // mvnw calls stay online. Maven resolves through the user's
      // ~/.m2/settings.xml mirror; forcing -o here would block
      // plugin-prefix lookups (e.g. `flyway:migrate`) on a cold runner.
      const mvnwHits = content.match(/\.\/mvnw\s+\S+/g) ?? [];
      for (const hit of mvnwHits) {
        expect(hit).not.toMatch(/\.\/mvnw -o\b/);
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
