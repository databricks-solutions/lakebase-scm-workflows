// Create a paired Lakebase branch for a git branch.
//
// Parent resolution precedence (ported from
// LakebaseService.createBranch):
//   1. Explicit `parentBranch` arg (caller-supplied; "branch from X" override).
//   2. The branch the caller is "currently on" (`currentBranch` arg), git-like
//      fork-from-current semantics. Skipped if it equals the target.
//   3. Project default branch (usually `production`).
//
// Returns the LakebaseBranchInfo when the branch reaches READY within the
// poll budget (default ~120s); throws otherwise.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "../util/delay.js";
import { sanitizeBranchName } from "../util/sanitize-branch-name.js";
import {
  LakebaseBranchError,
  LakebaseBranchInfo,
  BranchLookupOpts,
  getBranchByName,
  getDefaultBranch,
  projectPath,
} from "./branch-utils.js";

const execFileP = promisify(execFile);

export interface CreateBranchArgs extends BranchLookupOpts {
  /** Target branch name (will be sanitized to a Lakebase id). */
  branch: string;
  /**
   * Explicit parent branch override. Use for "fork from staging" or
   * "fork from production" hotfix scenarios. Pass the sanitized branch
   * name, NOT the full resource path.
   */
  parentBranch?: string;
  /**
   * Branch the caller is currently checked-out on (in agent runtimes,
   * read from .env's LAKEBASE_BRANCH_ID before calling this). When set
   * and not equal to the target, used as the parent (git-like "fork from
   * current"). Ignored when parentBranch override is provided.
   */
  currentBranch?: string;
  /** Wait-for-READY poll budget in milliseconds. Default 120_000. */
  readyTimeoutMs?: number;
  /** Poll interval in milliseconds. Default 5_000. */
  pollIntervalMs?: number;
}

/**
 * Create a Lakebase branch.
 *
 * Idempotent on a true retry: if a branch with the sanitized name already
 * exists AND its actual source matches the source the caller is asking
 * for now, returns the existing branch. If the existing branch was forked
 * from a *different* source, throws, silently returning a branch with
 * the wrong lineage would mask the user's intent (e.g. they meant to
 * branch from staging this time, but a stale branch from production
 * still occupies the name).
 */
export async function createBranch(args: CreateBranchArgs): Promise<LakebaseBranchInfo> {
  const sanitized = sanitizeBranchName(args.branch);
  const lookup: BranchLookupOpts = { instance: args.instance, host: args.host };

  // Resolve the source (parent) branch full path first, needed both for
  // create AND for the idempotency-vs-conflict comparison below.
  let sourceBranchPath: string | undefined;
  if (args.parentBranch) {
    sourceBranchPath = `${projectPath(args.instance)}/branches/${sanitizeBranchName(args.parentBranch)}`;
  } else if (args.currentBranch && args.currentBranch !== sanitized) {
    const current = await getBranchByName(args.currentBranch, lookup);
    if (current) sourceBranchPath = current.name;
  }
  if (!sourceBranchPath) {
    const def = await getDefaultBranch(lookup);
    if (!def) {
      throw new LakebaseBranchError(
        `Could not find a parent branch for "${sanitized}", no parentBranch override, ` +
          `no currentBranch hint, and the project has no default branch.`
      );
    }
    sourceBranchPath = def.name;
  }

  // Idempotency-vs-conflict: if the branch already exists, only return it
  // when its actual source matches what was just requested. Otherwise the
  // caller asked for a different parent than what's on file, and silently
  // handing back the stale branch would lie about the lineage.
  const existing = await getBranchByName(sanitized, lookup);
  if (existing) {
    const existingLeaf = leafOf(existing.sourceBranchName);
    const requestedLeaf = leafOf(sourceBranchPath);
    if (existingLeaf && requestedLeaf && existingLeaf !== requestedLeaf) {
      throw new LakebaseBranchError(
        `Branch "${sanitized}" already exists, but was forked from "${existingLeaf}", ` +
          `not the requested "${requestedLeaf}". Delete the existing branch first, ` +
          `or pick a different target name.`,
      );
    }
    return existing;
  }

  const spec = JSON.stringify({ spec: { source_branch: sourceBranchPath, no_expiry: true } });
  await dbcli(
    ["postgres", "create-branch", projectPath(args.instance), sanitized, "--json", spec],
    args.host
  );

  return waitForBranchReady({
    instance: args.instance,
    host: args.host,
    branch: sanitized,
    timeoutMs: args.readyTimeoutMs ?? 120_000,
    pollIntervalMs: args.pollIntervalMs ?? 5_000,
  });
}

export interface WaitForBranchReadyArgs extends BranchLookupOpts {
  branch: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Poll until the branch reaches READY state. Throws on timeout. */
export async function waitForBranchReady(args: WaitForBranchReadyArgs): Promise<LakebaseBranchInfo> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const interval = args.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const branch = await getBranchByName(args.branch, { instance: args.instance, host: args.host });
    if (branch && branch.state === "READY") return branch;
    await delay(interval);
  }
  throw new LakebaseBranchError(
    `Branch "${args.branch}" did not reach READY within ${timeoutMs}ms`
  );
}

/** Extract the branch leaf name from either a full path
 *  ("projects/X/branches/Y") or a bare leaf ("Y"). Returns undefined when
 *  input is empty/undefined so callers can decide whether the comparison
 *  is meaningful. */
function leafOf(pathOrName: string | undefined): string | undefined {
  if (!pathOrName) return undefined;
  const segments = pathOrName.split("/");
  return segments[segments.length - 1] || undefined;
}

async function dbcli(args: string[], host?: string): Promise<string> {
  const trimmedHost = host?.replace(/\/+$/, "");
  const env = trimmedHost
    ? ({ ...process.env, DATABRICKS_HOST: trimmedHost } as NodeJS.ProcessEnv)
    : process.env;
  try {
    const { stdout } = await execFileP("databricks", args, { env, timeout: 60_000 });
    return stdout.toString();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf8")
          : "";
    throw new LakebaseBranchError(
      `databricks ${args.join(" ")} failed: ${e.message}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`
    );
  }
}
