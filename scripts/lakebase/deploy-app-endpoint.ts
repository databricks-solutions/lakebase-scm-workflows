// Provision a Databricks Apps endpoint for a Lakebase-paired target.
//
// Slice 3 of FEIP-7130 (lakebase-apps-deploy). Uses the per-step deploy
// pattern (devhub platform-guide.md "Option B") because Lakebase Postgres
// Projects are NOT compatible with the bundle config's `database:`
// resource type (that block references the older Database Instances
// product). See ADR-0002's amendment for the full finding.
//
// Pairs with createPairedBranch (scripts/lakebase/paired-branch.ts):
// once a Lakebase branch + git branch exist, ensureAppEndpoint provisions
// the matching app endpoint and returns its URL.
//
// The deploy flow (idempotent on re-run):
//   1. uploadDirectory: per-file workspace import --overwrite
//   2. apps create (skip if app already exists)
//   3. apps deploy <name> --source-code-path <workspacePath>
//   4. apps get <name> --output json (read back the URL)
//
// Permissions are NOT granted here. The deployed app's service principal
// must be granted CAN_CONNECT_AND_CREATE on the Lakebase project
// separately (slice 5).

import { spawn } from "node:child_process";
import { exec } from "../util/exec.js";
import { KIT_TIMEOUTS } from "./kit-config.js";
import { uploadDirectory, UploadDirectoryResult } from "./deploy-workspace-upload.js";

export interface EnsureAppEndpointArgs {
  /** Local directory with package.json + app.yaml + source files. */
  workspaceRoot: string;
  /** Databricks Workspace path to upload source to (must be absolute, e.g.
   *  `/Workspace/Users/me/myapp`). Created if absent. */
  workspacePath: string;
  /** Databricks CLI profile for auth. */
  profile: string;
  /** App name (Databricks Apps constraints: <=26 chars, lowercase letters /
   *  digits / hyphens). */
  appName: string;
  /** Description set on initial `apps create`. Ignored if the app already
   *  exists. Default: "Deployed by lakebase-app-dev-kit". */
  description?: string;
  /** Override the `apps create` step timeout. The CLI blocks until the
   *  app reaches ACTIVE state; cold-start can take 5+ minutes. Default:
   *  1200s (matching the CLI's own --timeout 20m default). */
  createTimeoutMs?: number;
  /** Override the deploy step timeout. Apps deploy can take 5+ minutes on
   *  cold-start. Default: 600s. */
  deployTimeoutMs?: number;
}

export interface EnsureAppEndpointResult {
  /** True iff `apps deploy` exited 0. */
  ok: boolean;
  /** URL of the deployed app, fetched via `apps get` after deploy.
   *  Undefined if the get call failed (the app may still be deployed). */
  url: string | undefined;
  /** True if the app was just created (vs already existed). */
  created: boolean;
  /** Workspace upload step result. */
  upload: UploadDirectoryResult;
  /** Process exit code of the deploy command. */
  exitCode: number | null;
  /** Raw stdout from `apps deploy`. */
  deployStdout: string;
  /** Raw stderr from `apps deploy`. */
  deployStderr: string;
}

export interface GetAppEndpointArgs {
  profile: string;
  appName: string;
  timeoutMs?: number;
}

export interface GetAppEndpointResult {
  /** True iff the app exists on the workspace. */
  exists: boolean;
  /** URL of the app if it exists. */
  url: string | undefined;
  /** Parsed app info (the JSON `databricks apps get` returns). */
  info: Record<string, unknown> | undefined;
}

/**
 * Look up an existing app endpoint by name. Returns `exists: false`
 * (without throwing) when the app does not exist; throws on auth or
 * other infrastructure failures.
 */
export async function getAppEndpoint(args: GetAppEndpointArgs): Promise<GetAppEndpointResult> {
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.cliDefault;
  try {
    const stdout = await exec(
      `databricks apps get "${escapeShellArg(args.appName)}" --profile "${escapeShellArg(args.profile)}" -o json`,
      { timeout: timeoutMs }
    );
    const info = JSON.parse(stdout) as Record<string, unknown>;
    return {
      exists: true,
      url: typeof info.url === "string" ? info.url : undefined,
      info,
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (
      /RESOURCE_DOES_NOT_EXIST|does not exist|not found|404|status: 404/i.test(msg)
    ) {
      return { exists: false, url: undefined, info: undefined };
    }
    throw err;
  }
}

/**
 * Provision (create or update) a Databricks Apps endpoint via the
 * per-step pattern: upload source, ensure the app exists, deploy via
 * the API-direct path. Returns the deployed URL.
 *
 * Idempotent: re-running against an already-deployed app re-uploads
 * source + redeploys without recreating the app endpoint.
 *
 * Promise rejects only on infrastructure failures (CLI not on PATH,
 * timeout, upload step uncaught). Non-zero deploy exit codes resolve
 * to `ok: false` so callers compose with `.ok` rather than try/catch.
 */
export async function ensureAppEndpoint(args: EnsureAppEndpointArgs): Promise<EnsureAppEndpointResult> {
  const description = args.description ?? "Deployed by lakebase-app-dev-kit";
  const createTimeoutMs = args.createTimeoutMs ?? 1_200_000;
  const deployTimeoutMs = args.deployTimeoutMs ?? 600_000;

  // 1. Determine create-vs-update.
  // We DROP --no-wait so the CLI blocks until the app reaches ACTIVE.
  // `apps deploy` rejects with "not in RUNNING state" otherwise, since
  // a freshly-created app starts in CREATING and the deploy command
  // needs the app to be ready. The CLI's own --timeout (default 20m)
  // bounds the wait; our outer timeout matches.
  const lookup = await getAppEndpoint({ appName: args.appName, profile: args.profile });
  let created = false;
  if (!lookup.exists) {
    await exec(
      `databricks apps create "${escapeShellArg(args.appName)}" --description "${escapeShellArg(description)}" --profile "${escapeShellArg(args.profile)}"`,
      { timeout: createTimeoutMs }
    );
    created = true;
  }

  // 2. Upload source to the workspace path.
  const upload = await uploadDirectory({
    localRoot: args.workspaceRoot,
    workspacePath: args.workspacePath,
    profile: args.profile,
  });

  // 3. API-direct deploy: passing APP_NAME as positional arg switches
  //    the CLI out of bundle-deploy mode (which would try to read
  //    databricks.yml and reject Lakebase configs).
  const { ok, exitCode, stdout, stderr } = await runDeploy({
    appName: args.appName,
    workspacePath: args.workspacePath,
    profile: args.profile,
    timeoutMs: deployTimeoutMs,
  });

  // 4. Read back the URL (post-deploy state, separate from create-state).
  let url: string | undefined;
  try {
    const post = await getAppEndpoint({ appName: args.appName, profile: args.profile });
    url = post.url;
  } catch {
    // Non-fatal: keep url undefined, surface the deploy fields so the
    // caller can still diagnose.
  }

  return {
    ok,
    url,
    created,
    upload,
    exitCode,
    deployStdout: stdout,
    deployStderr: stderr,
  };
}

// ─── helpers ────────────────────────────────────────────────────

interface DeployResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runDeploy(args: {
  appName: string;
  workspacePath: string;
  profile: string;
  timeoutMs: number;
}): Promise<DeployResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "databricks",
      [
        "apps",
        "deploy",
        args.appName,
        "--source-code-path",
        args.workspacePath,
        "--profile",
        args.profile,
      ],
      { cwd: undefined }
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
      finish(() => reject(new Error(`databricks apps deploy failed to start: ${err.message}`)));
    });
    child.on("close", (code) => {
      finish(() => resolve({ ok: code === 0, exitCode: code, stdout, stderr }));
    });
    timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error(`databricks apps deploy timed out after ${args.timeoutMs}ms`));
      });
    }, args.timeoutMs);
  });
}

function escapeShellArg(s: string): string {
  return s.replace(/"/g, '\\"');
}
