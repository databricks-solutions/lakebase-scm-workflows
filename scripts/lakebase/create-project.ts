// Orchestrator for `lakebase create-project` – bootstrap a fresh
// Lakebase-paired project.
//
// Wired in FEIP-7071. All NotYetPortedError stubs are now real calls to
// the modules under scripts/. Mirrors ProjectCreationService.createProject
// from the extension; sync back to the extension via FEIP-7065.

import * as fs from "node:fs";
import * as path from "node:path";
import { writeEnvFile } from "./env-file.js";
import { verifyProject, verifyHooks, verifyWorkflows } from "./project-verify.js";
import { createRepo, getRepoFullName, getCurrentUser } from "../github/repo.js";
import { cloneRepo } from "../git/clone.js";
import { gitInit } from "../git/init.js";
import { commitAndPush } from "../git/commit-push.js";
import {
  createLakebaseProject,
  getDefaultBranchId,
} from "./lakebase-project.js";
import { scaffoldAll } from "./scaffold.js";
import { setupRunner } from "./runner-setup.js";
import { syncCiSecrets } from "../util/ci-secrets.js";
import { delay } from "../util/delay.js";

export interface CreateProjectArgs {
  /** Project name (Lakebase project id and local directory name). */
  projectName: string;
  /** Parent directory where the project folder will be created. */
  parentDir: string;
  /** Databricks workspace host URL (trailing slashes are stripped). */
  databricksHost: string;
  /** GitHub owner – required when createGithubRepo is true. */
  githubOwner?: string;
  /** Whether to create a GitHub repository (default: true). */
  createGithubRepo?: boolean;
  /** Whether to make the GitHub repo private (default: true). */
  privateRepo?: boolean;
  /** Project language stack (default: 'java'). */
  language?: "java" | "kotlin" | "python" | "nodejs";
  /** CI runner type (default: 'self-hosted'). */
  runnerType?: "self-hosted" | "github-hosted";
}

export interface CreateProjectResult {
  projectDir: string;
  githubRepoUrl?: string;
  lakebaseProjectId: string;
  lakebaseDefaultBranch: string;
  warnings: string[];
}

export type ProgressCallback = (step: string, detail?: string) => void;

/**
 * Orchestrate the 10-step project creation.
 *
 *   1. Create GitHub repo (Octokit) – useGithub only
 *   2. Wait for repo visibility (SAML/propagation) – useGithub only
 *   3. Clone repo OR git init local dir
 *   4. Create Lakebase project (databricks postgres create-project)
 *   5. Resolve default branch id
 *   6. Scaffold templates (common + language-specific via Spring Initializr or static).
 *      Ships .env.example only – .env is never written or committed by this flow.
 *      First post-checkout populates .env from .env.example with a fresh JWT.
 *   7. Sync CI secrets (DATABRICKS_HOST / LAKEBASE_PROJECT_ID / DATABRICKS_TOKEN) – useGithub
 *   8. Set up self-hosted runner – useGithub + self-hosted only
 *   9. Initial commit + push (workflow-scope error surfaced clearly) – push only if useGithub
 *  10. Health check (verifyHooks + verifyWorkflows) – warnings reported, not fatal
 */
export async function createProject(
  input: CreateProjectArgs,
  progress?: ProgressCallback
): Promise<CreateProjectResult> {
  const report = progress ?? (() => {});
  const projectDir = path.join(input.parentDir, input.projectName);
  const lakebaseProjectId = input.projectName;
  const host = input.databricksHost.replace(/\/+$/, "");
  const useGithub = input.createGithubRepo !== false;
  const language = input.language ?? "java";
  const runnerType = input.runnerType ?? "self-hosted";
  const warnings: string[] = [];

  if (useGithub && !input.githubOwner) {
    throw new Error("GitHub owner is required when creating a GitHub repository");
  }
  const fullRepoName = input.githubOwner
    ? `${input.githubOwner}/${input.projectName}`
    : "";

  // ── Step 1+2: GitHub repo + clone, OR local-only setup ────────
  if (useGithub) {
    report("Creating GitHub repository...", fullRepoName);
    await createRepo(fullRepoName, {
      private: input.privateRepo !== false,
      description: `Lakebase project: ${input.projectName}`,
    });

    report("Waiting for GitHub repo to be visible...", fullRepoName);
    const probeDelays = [1000, 2000, 3000, 5000, 8000];
    let probeErr = "";
    let visible = false;
    for (const waitMs of probeDelays) {
      try {
        await getRepoFullName(fullRepoName);
        visible = true;
        break;
      } catch (err) {
        probeErr = err instanceof Error ? err.message : String(err);
        await delay(waitMs);
      }
    }
    if (!visible) {
      let activeUser = "";
      try {
        activeUser = await getCurrentUser();
      } catch {
        /* ignore */
      }
      const samlHint = /SAML|scope does not match|sso/i.test(probeErr)
        ? "\n\nThe error mentions SAML – re-sign in to GitHub and authorize SSO for this org."
        : "";
      const userHint =
        activeUser && activeUser !== input.githubOwner
          ? `\n\nNote: signed in as "${activeUser}", but the repo was created under "${input.githubOwner}".`
          : "";
      throw new Error(
        `GitHub repo "${fullRepoName}" was created but isn't visible after ~19s of polling.${samlHint}${userHint}\n\nLast probe error:\n  ${probeErr.split("\n")[0].slice(0, 200)}`
      );
    }
    report("Cloning repository...", projectDir);
    await cloneRepo(`https://github.com/${fullRepoName}.git`, input.parentDir);
  } else {
    report("Creating local project directory...", projectDir);
    if (fs.existsSync(projectDir)) {
      throw new Error(`Directory already exists: ${projectDir}`);
    }
    fs.mkdirSync(projectDir, { recursive: true });
    await gitInit(projectDir);
  }

  // ── Step 3: Lakebase project ──────────────────────────────────
  report("Creating Lakebase database...", lakebaseProjectId);
  await createLakebaseProject({ projectId: lakebaseProjectId, host });

  // ── Step 4: Default branch lookup (non-fatal if not ready yet) ─
  report("Resolving database endpoint...");
  const defaultBranchId = await getDefaultBranchId({
    projectId: lakebaseProjectId,
    host,
  });

  // ── Step 5: Scaffold (templates + language project) ───────────
  report("Scaffolding project files...");
  await scaffoldAll({
    targetDir: projectDir,
    databricksHost: host,
    lakebaseProjectId,
    language,
    runnerType,
    report: (m, d) => report(m, d),
  });

  // (Step 6 – write .env – intentionally removed.)
  // Substrate ships .env.example only; .env is gitignored and never committed.
  // The post-checkout hook bootstraps .env from .env.example on first switch
  // and fills in the JWT-bearing connection material then. Keeping .env out
  // of the create flow eliminates the only path by which a real JWT could
  // end up staged in git.

  // ── Step 6: CI secrets (GitHub only) ──────────────────────────
  if (useGithub) {
    report("Setting up CI auth (service principal)...");
    try {
      await syncCiSecrets({
        projectDir,
        databricksHost: host,
        lakebaseProjectId,
        comment: "GitHub Actions CI",
        lifetimeSeconds: 86_400,
        ownerRepo: fullRepoName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`CI auth setup failed: ${msg}`);
      report(`Warning: CI auth setup failed (${msg})`);
    }
  }

  // ── Step 7: Self-hosted runner (GitHub + self-hosted only) ────
  if (useGithub && runnerType === "self-hosted") {
    report("Setting up self-hosted runner...");
    try {
      await setupRunner({
        fullRepoName,
        projectName: input.projectName,
        report: (m) => report(m),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Runner setup failed: ${msg}`);
      report(`Warning: runner setup failed (${msg}). CI workflows will queue until a runner is available.`);
    }
  } else if (useGithub) {
    report("Using GitHub-hosted runners – no local runner needed.");
  } else {
    report("Skipping runner setup (no GitHub repository).");
  }

  // ── Step 8: Initial commit (+ push when GitHub configured) ────
  const langLabels: Record<string, string> = {
    java: "Java/Spring Boot",
    kotlin: "Kotlin/Spring Boot",
    python: "Python/FastAPI",
    nodejs: "Node.js/Express",
  };
  const langLabel = langLabels[language] ?? language;
  report("Creating initial commit...");
  await commitAndPush({
    projectDir,
    message: `Initial project scaffold (${langLabel} + Lakebase)`,
    push: useGithub,
  });

  // ── Step 9: Health check (advisory) ───────────────────────────
  report("Verifying project...");
  const health = verifyProject(projectDir);
  for (const w of health.warnings) {
    warnings.push(w);
    report(`Warning: ${w}`);
  }

  report("Project created successfully!");
  return {
    projectDir,
    githubRepoUrl: useGithub ? `https://github.com/${fullRepoName}` : undefined,
    lakebaseProjectId,
    lakebaseDefaultBranch: defaultBranchId,
    warnings,
  };
}

// Re-exports for callers that only need ported leaves.
export { writeEnvFile, verifyHooks, verifyWorkflows, verifyProject };
