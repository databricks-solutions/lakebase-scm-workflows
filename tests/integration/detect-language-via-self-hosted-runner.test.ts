// FEIP-7138: live integration test that proves substrate's setupRunner
// primitive + the v0.3.0-alpha.20 npx routing of lakebase-detect-language
// work end-to-end against a real GitHub repository.
//
// What this test does:
//   1. Resolves the contributor's GitHub login from their substrate auth
//      (GITHUB_TOKEN / VS Code session / gh CLI, via resolveGitHubToken).
//   2. Creates a fresh private repo `<login>/detect-language-verify-<ts>`.
//   3. Writes a minimal project (pyproject.toml + a verify-detect-lang.yml
//      workflow that calls the pinned `npx --package=github:...#v<kit-ver>
//      lakebase-detect-language` on a self-hosted runner).
//   4. Pushes the project to the new repo.
//   5. Calls substrate's setupRunner() to register + start a self-hosted
//      runner against that repo.
//   6. Polls the resulting workflow run until completion (5min budget).
//   7. Asserts the run concluded "success" and the detect-lang step output
//      is "python".
//
// Teardown contract (mirrors the user's standing rule "never teardown on
// failure"):
//   - On assertion PASS: deregister runner + delete repo.
//   - On assertion FAIL: leave runner + repo intact, print recovery
//     commands.
//   - LAKEBASE_TEST_NO_TEARDOWN=1 forces leave-intact regardless.
//
// Gating:
//   LAKEBASE_TEST_E2E_GITHUB=1   must be set; suite skips otherwise.
//   GitHub auth must be resolvable by resolveGitHubToken (one of
//   GITHUB_TOKEN env / VS Code session / `gh auth login`).
//   Self-hosted runner traffic to github.com is required from the
//   machine running the test (the substrate-managed runner subprocess
//   polls github.com directly).
//
// Why not hermetic: the entire value of this test is exercising the real
// npx --package=github:... resolution against a real published tag and a
// real runner that GitHub's control plane assigns the job to. Mocking
// any of these surfaces just verifies the mock.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Octokit } from "octokit";
import { resolveGitHubToken } from "../../scripts/github/auth.js";
import { setupRunner, removeRunner } from "../../scripts/lakebase/runner-setup.js";

const E2E = process.env.LAKEBASE_TEST_E2E_GITHUB === "1";
const NO_TEARDOWN = process.env.LAKEBASE_TEST_NO_TEARDOWN === "1";
const KIT_VERSION = "v0.3.0-alpha.20";

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function git(workdir: string, args: string[]): void {
  execFileSync("git", args, { cwd: workdir, stdio: "inherit" });
}

describe.skipIf(!E2E)(
  "detect-language via self-hosted runner (live, FEIP-7138)",
  () => {
    let token: string;
    let owner: string;
    let repo: string;
    let fullRepoName: string;
    let projectName: string;
    let workdir: string;
    let octokit: Octokit;
    let allPassed = false;

    beforeAll(async () => {
      token = await resolveGitHubToken();
      octokit = new Octokit({ auth: token });

      const me = await octokit.rest.users.getAuthenticated();
      owner = me.data.login;
      repo = `detect-language-verify-${timestamp()}`;
      fullRepoName = `${owner}/${repo}`;
      projectName = repo;

      console.log("");
      console.log("[NOTICE] FEIP-7138 will create the following:");
      console.log(`         repo:    ${fullRepoName} (private)`);
      console.log(`         runner:  ~/.lakebase/runners/${projectName}/`);
      console.log(`         binary:  ~/.cache/github-actions-runner/`);
      console.log("");
      console.log("         Recovery if the test is killed mid-run:");
      console.log(`           gh repo delete ${fullRepoName} --yes`);
      console.log(
        `           node -e 'import("@databricks-solutions/lakebase-app-dev-kit/lakebase").then(m =>` +
          ` m.removeRunner({fullRepoName: "${fullRepoName}", projectName: "${projectName}"}))'`,
      );
      console.log("");

      await octokit.rest.repos.createForAuthenticatedUser({
        name: repo,
        private: true,
        auto_init: false,
        description: "Throwaway: substrate detect-language CLI integration test (FEIP-7138).",
      });

      workdir = fs.mkdtempSync(path.join(os.tmpdir(), `${repo}-`));
      fs.writeFileSync(
        path.join(workdir, "pyproject.toml"),
        '[project]\nname = "detect-language-verify"\nversion = "0.0.0"\n',
      );
      fs.mkdirSync(path.join(workdir, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(workdir, ".github", "workflows", "verify-detect-lang.yml"),
        verifyWorkflow(KIT_VERSION),
      );

      git(workdir, ["init", "-q", "-b", "main"]);
      git(workdir, ["-c", `user.email=integration-test@${owner}.local`, "-c", `user.name=${owner}`, "add", "-A"]);
      git(workdir, [
        "-c",
        `user.email=integration-test@${owner}.local`,
        "-c",
        `user.name=${owner}`,
        "commit",
        "-q",
        "-m",
        "FEIP-7138 verify substrate detect-language CLI on self-hosted runner",
      ]);
      git(workdir, [
        "remote",
        "add",
        "origin",
        `https://x-access-token:${token}@github.com/${fullRepoName}.git`,
      ]);

      console.log(`  [setup] starting self-hosted runner for ${fullRepoName}`);
      await setupRunner({ fullRepoName, projectName, report: (m) => console.log(`    ${m}`) });

      console.log(`  [setup] pushing main to ${fullRepoName}`);
      git(workdir, ["push", "-q", "-u", "origin", "main"]);
    }, 180_000);

    it("runs lakebase-detect-language end-to-end and detects python", async () => {
      const runId = await pollForFirstRun(octokit, owner, repo);
      console.log(`  [poll] watching workflow run ${runId}`);
      const run = await pollUntilComplete(octokit, owner, repo, runId, 5 * 60_000);

      expect(run.conclusion).toBe("success");

      const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      const detectStep = jobs.data.jobs[0]?.steps?.find((s) => s.name === "Detect project language");
      expect(detectStep?.conclusion).toBe("success");

      const assertStep = jobs.data.jobs[0]?.steps?.find(
        (s) => s.name === "Assert language is python (pyproject.toml present)",
      );
      expect(assertStep?.conclusion).toBe("success");

      allPassed = true;
    }, 6 * 60_000);

    afterAll(async () => {
      if (!allPassed || NO_TEARDOWN) {
        console.log("");
        console.log("[LEAVE-INTACT] Skipping teardown (test failed or NO_TEARDOWN set).");
        console.log("         To clean up manually:");
        console.log(`           gh repo delete ${fullRepoName} --yes`);
        console.log(
          `           node -e 'import("@databricks-solutions/lakebase-app-dev-kit/lakebase").then(m =>` +
            ` m.removeRunner({fullRepoName: "${fullRepoName}", projectName: "${projectName}"}))'`,
        );
        return;
      }

      try {
        await removeRunner({ fullRepoName, projectName });
      } catch (e) {
        console.log(`  [teardown] removeRunner failed: ${(e as Error).message}`);
      }
      try {
        await octokit.rest.repos.delete({ owner, repo });
      } catch (e) {
        console.log(`  [teardown] repo delete failed: ${(e as Error).message}`);
      }

      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }, 120_000);
  },
);

async function pollForFirstRun(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const runs = await octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 1 });
    const first = runs.data.workflow_runs[0];
    if (first) return first.id;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`No workflow run appeared on ${owner}/${repo} within 60s`);
}

async function pollUntilComplete(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  budgetMs: number,
): Promise<{ status: string | null; conclusion: string | null }> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const run = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
    if (run.data.status === "completed") {
      return { status: run.data.status, conclusion: run.data.conclusion };
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Workflow run ${runId} did not complete within ${budgetMs / 1000}s`);
}

function verifyWorkflow(kitVersion: string): string {
  return `name: Verify substrate detect-language CLI

on:
  push:
    branches: ["**"]
  workflow_dispatch:

jobs:
  detect-language:
    runs-on: [self-hosted]
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Detect project language
        id: detect-lang
        run: |
          LANG="$(npx --yes \\
            --package=github:databricks-solutions/lakebase-app-dev-kit#${kitVersion} \\
            lakebase-detect-language)"
          echo "lang=$LANG" >> $GITHUB_OUTPUT
          echo "Detected language: $LANG"

      - name: Assert language is python (pyproject.toml present)
        run: |
          if [ "\${{ steps.detect-lang.outputs.lang }}" != "python" ]; then
            echo "FAIL: expected 'python', got '\${{ steps.detect-lang.outputs.lang }}'"
            exit 1
          fi
          echo "PASS: detect-lang resolved to python as expected"
`;
}
