// Roll back a Databricks App to a previous deployment. Slice 6 of
// FEIP-7130 (lakebase-apps-deploy).
//
// The Databricks Apps platform tracks deployment history per app
// (`databricks apps list-deployments <name>`). Each deployment carries
// a status (SUCCEEDED / FAILED / CANCELLED / IN_PROGRESS / STOPPED)
// and a `source_code_path`. Rollback re-deploys a prior SUCCEEDED
// deployment by passing its `source_code_path` to `apps deploy`.
//
// Two callsite shapes:
//   - Explicit: pass `deploymentId` to roll back to a specific past
//     deployment.
//   - Auto: omit `deploymentId`; the primitive finds the most recent
//     SUCCEEDED deployment whose id is NOT the one currently active
//     (i.e. the previous good state). Throws if no such deployment
//     exists (app has only one or zero green deploys).
//
// Pairs with `ensureAppEndpoint`: when an ensure call fails on the
// deploy step, the caller can rollback to restore service. The rollback
// itself is a fresh `apps deploy` call, so the same 5-15 min cold-start
// budget applies; the rollback's outcome surfaces via the same
// structured result shape as `ensureAppEndpoint`.

import { spawn } from "node:child_process";
import { exec } from "../util/exec.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

export interface RollbackDeployArgs {
  /** Databricks CLI profile. */
  profile: string;
  /** App name to roll back. */
  appName: string;
  /** Explicit deployment id to roll back to. When omitted, the
   *  primitive auto-selects the most recent SUCCEEDED deployment
   *  before the currently active one. */
  deploymentId?: string;
  /** Override the rollback deploy timeout. Default: 600s. */
  timeoutMs?: number;
}

export interface RollbackDeployResult {
  /** True iff the rollback `apps deploy` returned exit 0. */
  ok: boolean;
  /** Deployment id rolled back TO. */
  toDeploymentId: string;
  /** source_code_path of the deployment that was rolled back to. */
  sourceCodePath: string;
  /** Process exit code of the deploy command. */
  exitCode: number | null;
  /** Raw stdout from `apps deploy`. */
  deployStdout: string;
  /** Raw stderr from `apps deploy`. */
  deployStderr: string;
}

interface DeploymentInfo {
  deployment_id?: string;
  source_code_path?: string;
  status?: { state?: string };
  state?: string;
  create_time?: string;
}

/**
 * List all deployments for an app, parsed and typed.
 */
export async function listAppDeployments(args: {
  profile: string;
  appName: string;
  timeoutMs?: number;
}): Promise<DeploymentInfo[]> {
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.cliDefault;
  const stdout = await exec(
    `databricks apps list-deployments "${escapeShellArg(args.appName)}" --profile "${escapeShellArg(args.profile)}" -o json`,
    { timeout: timeoutMs }
  );
  const parsed = JSON.parse(stdout) as unknown;
  // The CLI may return a bare array or an object with `app_deployments`/`items`.
  if (Array.isArray(parsed)) return parsed as DeploymentInfo[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const arr = obj.app_deployments ?? obj.deployments ?? obj.items;
    if (Array.isArray(arr)) return arr as DeploymentInfo[];
  }
  return [];
}

/**
 * Roll back an app to a prior deployment.
 *
 * - With `deploymentId` set: re-deploys that exact deployment's
 *   source_code_path.
 * - Without `deploymentId`: lists deployments, picks the most recent
 *   SUCCEEDED one that is NOT the current active deployment, and
 *   re-deploys its source_code_path. Throws when no such deployment
 *   exists (the app has 0 or 1 historical succeeded deploys).
 *
 * Returns a structured result for any deploy exit code; rejects only
 * on infrastructure failures (CLI not on PATH, timeout, list call
 * fails).
 */
export async function rollbackDeploy(args: RollbackDeployArgs): Promise<RollbackDeployResult> {
  const timeoutMs = args.timeoutMs ?? 600_000;
  const deployments = await listAppDeployments({
    profile: args.profile,
    appName: args.appName,
  });

  let target: DeploymentInfo | undefined;
  if (args.deploymentId) {
    target = deployments.find((d) => d.deployment_id === args.deploymentId);
    if (!target) {
      throw new Error(
        `Deployment "${args.deploymentId}" not found among ${deployments.length} deployments for app "${args.appName}"`,
      );
    }
  } else {
    // The list is returned newest-first per the CLI's default ordering.
    // The most recent (index 0) is the currently-active deployment;
    // we want the most recent SUCCEEDED before that.
    const succeeded = deployments.filter((d) => stateOf(d) === "SUCCEEDED");
    if (succeeded.length < 2) {
      throw new Error(
        `App "${args.appName}" has ${succeeded.length} succeeded deployment(s); need at least 2 to auto-rollback`,
      );
    }
    target = succeeded[1]; // skip current, take previous
  }

  const sourceCodePath = typeof target.source_code_path === "string" ? target.source_code_path : "";
  if (!sourceCodePath) {
    throw new Error(
      `Target deployment "${target.deployment_id}" has no source_code_path; cannot rollback`,
    );
  }
  const toDeploymentId = typeof target.deployment_id === "string" ? target.deployment_id : "";

  const { ok, exitCode, stdout, stderr } = await runRollbackDeploy({
    appName: args.appName,
    sourceCodePath,
    profile: args.profile,
    timeoutMs,
  });

  return {
    ok,
    toDeploymentId,
    sourceCodePath,
    exitCode,
    deployStdout: stdout,
    deployStderr: stderr,
  };
}

// ─── helpers ────────────────────────────────────────────────────

function stateOf(d: DeploymentInfo): string {
  return (d.status?.state ?? d.state ?? "").toUpperCase();
}

interface DeployOut {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runRollbackDeploy(args: {
  appName: string;
  sourceCodePath: string;
  profile: string;
  timeoutMs: number;
}): Promise<DeployOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "databricks",
      [
        "apps",
        "deploy",
        args.appName,
        "--source-code-path",
        args.sourceCodePath,
        "--profile",
        args.profile,
      ],
      { cwd: undefined },
    );
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb();
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish(() => reject(new Error(`databricks apps deploy (rollback) failed to start: ${err.message}`)));
    });
    child.on("close", (code) => {
      finish(() => resolve({ ok: code === 0, exitCode: code, stdout, stderr }));
    });
    timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error(`databricks apps deploy (rollback) timed out after ${args.timeoutMs}ms`));
      });
    }, args.timeoutMs);
  });
}

function escapeShellArg(s: string): string {
  return s.replace(/"/g, '\\"');
}
