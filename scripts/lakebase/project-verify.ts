// Post-scaffold health checks, verify that the expected git hooks and
// GitHub Actions workflows landed on disk. Same shape the extension's
// ScaffoldService exposes; the result drives the "Warning: some hooks not
// installed" surface in create-project's final step.

import * as fs from "node:fs";
import * as path from "node:path";

export interface HookVerification {
  postCheckout: boolean;
  prepareCommitMsg: boolean;
  prePush: boolean;
}

export interface WorkflowVerification {
  pr: boolean;
  merge: boolean;
}

/** Returns true/false for each of the three hooks the workflow ops rely on. */
export function verifyHooks(projectDir: string): HookVerification {
  const hooksDir = path.join(projectDir, ".git", "hooks");
  return {
    postCheckout: fs.existsSync(path.join(hooksDir, "post-checkout")),
    prepareCommitMsg: fs.existsSync(path.join(hooksDir, "prepare-commit-msg")),
    prePush: fs.existsSync(path.join(hooksDir, "pre-push")),
  };
}

/** Returns true/false for each of the two GitHub Actions workflows. */
export function verifyWorkflows(projectDir: string): WorkflowVerification {
  const wfDir = path.join(projectDir, ".github", "workflows");
  return {
    pr: fs.existsSync(path.join(wfDir, "pr.yml")),
    merge: fs.existsSync(path.join(wfDir, "merge.yml")),
  };
}

/** Combined health report; convenient for the create-project final step. */
export function verifyProject(projectDir: string): {
  hooks: HookVerification;
  workflows: WorkflowVerification;
  warnings: string[];
} {
  const hooks = verifyHooks(projectDir);
  const workflows = verifyWorkflows(projectDir);
  const warnings: string[] = [];
  if (!hooks.postCheckout || !hooks.prepareCommitMsg || !hooks.prePush) {
    warnings.push("Some git hooks not installed (post-checkout / prepare-commit-msg / pre-push)");
  }
  if (!workflows.pr || !workflows.merge) {
    warnings.push("Some GitHub Actions workflows missing (pr.yml / merge.yml)");
  }
  return { hooks, workflows, warnings };
}
