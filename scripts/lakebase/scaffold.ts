// Static scaffold operations – port of ScaffoldService's template-copy
// methods. Spring Initializr (Java/Kotlin starter download) is a separate
// concern, ported in FEIP-7073.
//
// All methods read from the bundled templates/project/ tree. By default the
// module locates it relative to its own source by walking up looking for
// the gitignore-base marker file; tests can override with `templatesDir`.

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deployLanguageProject } from "./scaffold-language.js";
import type { ProjectLanguage } from "./scaffold-language.js";
import type { SpringInitializrClient } from "./spring-initializr.js";

export type { ProjectLanguage };
export type RunnerType = "self-hosted" | "github-hosted";
export type ScaffoldReportFn = (message: string, detail?: string) => void;

/**
 * Walk up from the compiled module location looking for the canonical
 * marker file (templates/project/common/.gitignore.base). Works whether
 * the module is run from src/ (tsx) or dist/ (tsc).
 */
let cachedTemplatesDir: string | undefined;
function findTemplatesDir(): string {
  if (cachedTemplatesDir) return cachedTemplatesDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "templates", "project");
    if (fs.existsSync(path.join(candidate, "common", ".gitignore.base"))) {
      cachedTemplatesDir = candidate;
      return cachedTemplatesDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate templates/project tree relative to ${here}. ` +
      `Pass explicit { templatesDir } to override.`
  );
}

export interface ScaffoldOptions {
  /** Override the templates/project root. Default: auto-detected. */
  templatesDir?: string;
}

function templatesRoot(opts?: ScaffoldOptions): string {
  return opts?.templatesDir ?? findTemplatesDir();
}

function commonDir(opts?: ScaffoldOptions): string {
  return path.join(templatesRoot(opts), "common");
}

function langDir(language: ProjectLanguage, opts?: ScaffoldOptions): string {
  return path.join(templatesRoot(opts), language);
}

/**
 * Recursively copy srcDir into destDir. Returns paths relative to destDir
 * (e.g. ["foo.sh", "ci/bar.sh"]) – fixes the bug in the extension's
 * ScaffoldService.copyDir which returned flat names and silently lost
 * subdirectory structure (caller couldn't actually stat the returned paths).
 */
function copyDir(srcDir: string, destDir: string, makeExecutable: boolean, relPrefix = ""): string[] {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory not found: ${srcDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const out: string[] = [];
  for (const entry of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const destPath = path.join(destDir, entry);
    const relPath = relPrefix ? path.join(relPrefix, entry) : entry;
    if (fs.statSync(srcPath).isDirectory()) {
      out.push(...copyDir(srcPath, destPath, makeExecutable, relPath));
    } else {
      fs.copyFileSync(srcPath, destPath);
      if (makeExecutable) {
        fs.chmodSync(destPath, 0o755);
      }
      out.push(relPath);
    }
  }
  return out;
}

// ── Deploy methods ───────────────────────────────────────────────

/** Deploy all scripts from common/scripts/. Files become executable. */
export async function deployScripts(targetDir: string, opts?: ScaffoldOptions): Promise<string[]> {
  return copyDir(path.join(commonDir(opts), "scripts"), path.join(targetDir, "scripts"), true);
}

/** Deploy GitHub Actions workflows from common/.github/workflows/. */
export async function deployWorkflows(targetDir: string, opts?: ScaffoldOptions): Promise<string[]> {
  const written = copyDir(
    path.join(commonDir(opts), ".github", "workflows"),
    path.join(targetDir, ".github", "workflows"),
    false
  );
  substituteWorkflowPlaceholders(
    path.join(targetDir, ".github", "workflows"),
    opts
  );
  return written;
}

/**
 * Read the kit's `package.json` version. The kit root sits two levels
 * above `templates/project`; tests can pass `templatesDir` to override
 * which kit's package.json is consulted. When the package.json is
 * missing or malformed the version comes through as the literal string
 * "unknown" rather than throwing, so a scaffold against a test fixture
 * tree without a package.json still completes (its YAML will pin to
 * the literal "unknown" tag, which is fine for hermetic tests).
 */
function kitVersion(opts?: ScaffoldOptions): string {
  try {
    const kitRoot = path.dirname(path.dirname(templatesRoot(opts)));
    const raw = fs.readFileSync(path.join(kitRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Rewrite scaffolded workflow YAML files for per-project values that
 * can only be known at scaffold time.
 *
 * Today: substitute `{{LAKEBASE_KIT_VERSION}}` with the kit version
 * that ran the scaffold. Future-proofed for additional placeholders.
 */
function substituteWorkflowPlaceholders(workflowDir: string, opts?: ScaffoldOptions): void {
  if (!fs.existsSync(workflowDir)) return;
  const version = kitVersion(opts);
  for (const entry of fs.readdirSync(workflowDir)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const filePath = path.join(workflowDir, entry);
    const before = fs.readFileSync(filePath, "utf-8");
    const after = before.replace(/\{\{LAKEBASE_KIT_VERSION\}\}/g, version);
    if (after !== before) fs.writeFileSync(filePath, after);
  }
}

/**
 * Install git hooks by copying template scripts into .git/hooks.
 * Requires {@param targetDir}/.git to already exist (caller ran git init).
 */
export async function installHooks(targetDir: string): Promise<string> {
  const scriptsDir = path.join(targetDir, "scripts");
  const gitHooksDir = path.join(targetDir, ".git", "hooks");
  if (!fs.existsSync(path.join(targetDir, ".git"))) {
    throw new Error(`Not a git repo root: ${targetDir}`);
  }
  fs.mkdirSync(gitHooksDir, { recursive: true });

  // Pin core.hooksPath to this project's .git/hooks. Without this, a globally
  // configured core.hooksPath (common in monorepo orgs that ship a corporate
  // pre-commit secret scanner via ~/.databricks/githooks or similar) makes
  // git skip .git/hooks entirely - our Lakebase hooks would be installed but
  // never fire. Project-local config takes precedence over global, so this
  // guarantees the hooks we just copied are the ones git invokes. Mirrors
  // install-hook.sh for callers who bootstrap manually.
  cp.execSync("git config --local core.hooksPath .git/hooks", {
    cwd: targetDir,
    stdio: "pipe",
  });

  const hookPairs: Array<[string, string]> = [
    ["post-checkout.sh", "post-checkout"],
    ["prepare-commit-msg.sh", "prepare-commit-msg"],
    ["pre-push.sh", "pre-push"],
    ["post-merge.sh", "post-merge"],
  ];
  const installed: string[] = [];
  for (const [srcName, hookName] of hookPairs) {
    const src = path.join(scriptsDir, srcName);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(gitHooksDir, hookName);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    installed.push(hookName);
  }
  return `Installed hooks: ${installed.join(", ") || "none"}`;
}

export interface DeployEnvExampleArgs extends ScaffoldOptions {
  databricksHost?: string;
  lakebaseProjectId?: string;
}

/** Render the .env template with the project's known credentials filled
 *  in. Shared between deployEnvExample (the tracked template) and deployEnv
 *  (the live config). Both files end up with the same non-secret values;
 *  secrets (JWT, DB_PASSWORD, DATABASE_URL) are filled in later by the
 *  post-checkout hook. */
function renderEnvFromTemplate(args: DeployEnvExampleArgs): string {
  const src = path.join(commonDir(args), ".env.example");
  let content = fs.readFileSync(src, "utf-8");
  if (args.databricksHost) {
    content = content.replace(/DATABRICKS_HOST=.*/, `DATABRICKS_HOST=${args.databricksHost}`);
  }
  if (args.lakebaseProjectId) {
    content = content.replace(/LAKEBASE_PROJECT_ID=.*/, `LAKEBASE_PROJECT_ID=${args.lakebaseProjectId}`);
  }
  return content;
}

/** Deploy .env.example with optional value substitution. */
export async function deployEnvExample(targetDir: string, args: DeployEnvExampleArgs = {}): Promise<void> {
  fs.writeFileSync(path.join(targetDir, ".env.example"), renderEnvFromTemplate(args));
}

/** Deploy .env with the project's credentials already filled in. The
 *  create-project flow has these credentials in hand (LAKEBASE_PROJECT_ID
 *  is the project being scaffolded; DATABRICKS_HOST is the target workspace
 *  the user picked), so populating .env immediately avoids the gated-hook
 *  problem where the post-checkout hook bails on empty LAKEBASE_PROJECT_ID
 *  and never refreshes .env on subsequent checkouts. .env is gitignored
 *  (see .gitignore.base) - never enters git history. Secrets (JWT,
 *  DB_PASSWORD, DATABASE_URL) are written by the hook on first checkout. */
export async function deployEnv(targetDir: string, args: DeployEnvExampleArgs = {}): Promise<void> {
  fs.writeFileSync(path.join(targetDir, ".env"), renderEnvFromTemplate(args));
}

/** Deploy deploy-targets.yaml with optional {{PROJECT_NAME}} substitution. */
export async function deployDeployTargets(
  targetDir: string,
  projectName?: string,
  opts?: ScaffoldOptions
): Promise<void> {
  const src = path.join(commonDir(opts), "deploy-targets.yaml");
  const dest = path.join(targetDir, "deploy-targets.yaml");
  if (!fs.existsSync(src)) return;
  let content = fs.readFileSync(src, "utf-8");
  if (projectName) {
    content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
  }
  fs.writeFileSync(dest, content);
}

/** Deploy .vscode/settings.json (disables built-in Git SCM). */
export async function deployVscodeSettings(targetDir: string, opts?: ScaffoldOptions): Promise<void> {
  const src = path.join(commonDir(opts), ".vscode", "settings.json");
  const destDir = path.join(targetDir, ".vscode");
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, "settings.json"));
}

/** Deploy .gitignore: common/.gitignore.base + <language>/.gitignore.extra. */
export async function deployGitignore(
  targetDir: string,
  language: ProjectLanguage = "java",
  opts?: ScaffoldOptions
): Promise<void> {
  const base = fs.readFileSync(path.join(commonDir(opts), ".gitignore.base"), "utf-8");
  const extraPath = path.join(langDir(language, opts), ".gitignore.extra");
  const extra = fs.existsSync(extraPath) ? fs.readFileSync(extraPath, "utf-8") : "";
  fs.writeFileSync(path.join(targetDir, ".gitignore"), base + "\n" + extra);
}

/**
 * Patch the deployed workflows for the chosen runner type.
 *
 * Templates ship with `runs-on: self-hosted` + `actions/setup-java@v4`. This
 * is a historical default: most workspaces today register a self-hosted
 * runner alongside the project, so the templates match that path out of the
 * box (no patch needed - it just falls through and works).
 *
 * For each non-default mode, swap the bits that need swapping:
 *   - github-hosted: replace `runs-on: self-hosted` -> `runs-on: ubuntu-latest`
 *     across all .github/workflows/*.yml. setup-java already targets the
 *     online Maven on github-hosted runners, so nothing else changes.
 *   - self-hosted: replace the actions/setup-java block with a local-JDK
 *     detection step (the self-hosted runner pre-provisions JDK + a Maven
 *     mirror, so we don't want the online setup-java step).
 */
export async function patchWorkflowsForRunnerType(targetDir: string, runnerType: RunnerType): Promise<void> {
  const workflowDir = path.join(targetDir, ".github", "workflows");

  if (runnerType === "github-hosted") {
    for (const file of fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir) : []) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const filePath = path.join(workflowDir, file);
      let content = fs.readFileSync(filePath, "utf-8");
      content = content.replace(/runs-on: self-hosted/g, "runs-on: ubuntu-latest");
      fs.writeFileSync(filePath, content);
    }
    return;
  }

  // self-hosted: keep `runs-on: self-hosted` (template default) and swap in
  // local-JDK detection in place of actions/setup-java.
  const localJdkStep = [
    "- name: Set up JDK (local)",
    "        run: |",
    '          echo "Using local JDK:"',
    "          java -version",
    '          if [ -z "$JAVA_HOME" ]; then',
    '            export JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || dirname $(dirname $(readlink -f $(which java))))"',
    '            echo "JAVA_HOME=$JAVA_HOME" >> $GITHUB_ENV',
    "          fi",
    '          echo "JAVA_HOME=$JAVA_HOME"',
    "",
  ].join("\n");

  for (const file of ["pr.yml", "merge.yml"]) {
    const filePath = path.join(workflowDir, file);
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, "utf-8");
    // Replace actions/setup-java block with local JDK step.
    // (Bug-fix from ScaffoldService: allow optional `if:` / other directives
    // between "- name: Set up JDK" and "uses: actions/setup-java@v4". The
    // extension's regex required them adjacent and silently no-op'd against
    // current templates – surface this back via FEIP-7065 when the extension
    // re-routes to this module.)
    content = content.replace(
      /- name: Set up JDK\n(?:\s+[\w-]+:.*\n)*\s+uses: actions\/setup-java@v4\n\s+with:\n(?:\s+#[^\n]*\n)*(?:\s+[\w-]+:.*\n)+/g,
      localJdkStep
    );
    fs.writeFileSync(filePath, content);
  }
}

// ── Orchestrator ────────────────────────────────────────────────

export interface ScaffoldStaticAllArgs extends ScaffoldOptions {
  targetDir: string;
  databricksHost?: string;
  lakebaseProjectId?: string;
  language?: ProjectLanguage;
  runnerType?: RunnerType;
  report?: ScaffoldReportFn;
}

export interface ScaffoldAllArgs extends ScaffoldStaticAllArgs {
  /** Optional Initializr client override for tests. */
  initializrClient?: SpringInitializrClient;
}

export interface ScaffoldStaticAllResult {
  scripts: string[];
  workflows: string[];
  hooksInstalled: string;
}

/**
 * Orchestrate the static (non-language-project) portion of scaffolding.
 * Language-specific files (Spring Initializr for Java/Kotlin, static
 * templates for Python/Node) ship in FEIP-7073.
 *
 * Caller must have already created targetDir and run `git init` there
 * (installHooks requires .git/).
 */
export async function scaffoldStaticAll(args: ScaffoldStaticAllArgs): Promise<ScaffoldStaticAllResult> {
  const report = args.report ?? (() => {});
  const language = args.language ?? "java";
  const runnerType = args.runnerType ?? "self-hosted";
  const opts: ScaffoldOptions = { templatesDir: args.templatesDir };

  report("Deploying .env.example");
  await deployEnvExample(args.targetDir, {
    ...opts,
    databricksHost: args.databricksHost,
    lakebaseProjectId: args.lakebaseProjectId,
  });

  report("Deploying .env");
  await deployEnv(args.targetDir, {
    ...opts,
    databricksHost: args.databricksHost,
    lakebaseProjectId: args.lakebaseProjectId,
  });

  report("Deploying .vscode/settings.json");
  await deployVscodeSettings(args.targetDir, opts);

  report("Deploying deploy-targets.yaml");
  await deployDeployTargets(args.targetDir, args.lakebaseProjectId, opts);

  report("Deploying .gitignore", language);
  await deployGitignore(args.targetDir, language, opts);

  report("Deploying scripts/");
  const scripts = await deployScripts(args.targetDir, opts);

  report("Deploying .github/workflows/");
  const workflows = await deployWorkflows(args.targetDir, opts);

  report("Patching workflows for runner type", runnerType);
  await patchWorkflowsForRunnerType(args.targetDir, runnerType);

  report("Installing git hooks");
  const hooksInstalled = await installHooks(args.targetDir);

  return { scripts, workflows, hooksInstalled };
}

/**
 * Full scaffold: static files (scaffoldStaticAll) + language-specific
 * project (Spring Initializr for Java/Kotlin; static template copy for
 * Python/Node). Mirror of ScaffoldService.scaffoldAll. Order matters –
 * language project is deployed LAST so its src/ doesn't shadow scaffold
 * scripts (which live at the project root, not under src/).
 */
export async function scaffoldAll(args: ScaffoldAllArgs): Promise<ScaffoldStaticAllResult> {
  const report = args.report ?? (() => {});
  const language = args.language ?? "java";
  const projectName = args.lakebaseProjectId;

  const staticResult = await scaffoldStaticAll(args);

  report(`Deploying language project (${language})`);
  await deployLanguageProject({
    targetDir: args.targetDir,
    language,
    projectName,
    templatesDir: args.templatesDir,
    initializrClient: args.initializrClient,
    report,
  });

  // Spring Initializr's starter zip ships its own .gitignore (generic JVM
  // entries: target/, *.class, .idea/). Extracting that zip into the
  // scaffold target overwrites the substrate-curated .gitignore that
  // scaffoldStaticAll just wrote (which includes .env, .tmp/, etc.).
  // Without re-applying substrate's .gitignore here, the next `git add`
  // tracks .env, leaking credentials into history. Re-apply is idempotent;
  // substrate's java/.gitignore.extra already covers the JVM entries
  // Initializr would have contributed.
  await deployGitignore(args.targetDir, language, { templatesDir: args.templatesDir });

  return staticResult;
}
