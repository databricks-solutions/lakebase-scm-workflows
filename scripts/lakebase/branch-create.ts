// Create a paired Lakebase branch for a git branch.
//
// Parent resolution precedence (ported from
// LakebaseService.createBranch):
//   1. Explicit `parentBranch` arg (caller-supplied; "branch from X" override).
//   2. The branch the caller is "currently on" (`currentBranch` arg) – git-like
//      fork-from-current semantics. Skipped if it equals the target.
//   3. Project default branch (usually `production`).
//
// Returns the LakebaseBranchInfo when the branch reaches READY within the
// poll budget (default ~120s); throws otherwise.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "../util/delay.js";
import { sanitizeBranchName } from "../util/sanitize-branch-name.js";
import { asBranchName, looksLikeBranchUid } from "./branch-id.js";
import {
  LakebaseBranchError,
  LakebaseBranchInfo,
  LakebaseBranchTtlTooLongError,
  BranchLookupOpts,
  getBranchByName,
  getDefaultBranch,
  isTtlTooLongError,
  projectPath,
} from "./branch-utils.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

const execFileP = promisify(execFile);

export interface CreateBranchArgs extends BranchLookupOpts {
  /** Target branch name (will be sanitized to a Lakebase id). */
  branch: string;
  /**
   * Explicit parent branch override. Use for "fork from staging" or
   * "fork from production" hotfix scenarios.
   *
   * Must be a BranchName (the resource-path leaf, e.g. `production`,
   * `staging`, `feature-x`) — NOT a BranchUid (`br-…`) and NOT a full
   * resource path. The runtime guard inside createBranch will reject a
   * BranchUid-shaped value with a helpful error. Use `asBranchName(s)`
   * at the call site if you have a string of unknown provenance.
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
  /**
   * If true, the spec sets `no_expiry: true` so Lakebase never auto-deletes
   * the branch. Lakebase's API requires one of expire_time / ttl /
   * no_expiry to be set on every create-branch call; omitting all three is
   * rejected. Default behavior: no_expiry: true if `ttl` is also unset;
   * if `ttl` is set, that wins and noExpiry must be omitted or false.
   * Mutually exclusive with `ttl`.
   */
  noExpiry?: boolean;
  /**
   * Lakebase-format TTL string ("<seconds>s", e.g. "604800s" = 7 days). When
   * set, Lakebase auto-deletes the branch after this duration relative to
   * create_time. Use for finite-lifetime workflow tiers (feature / test /
   * uat / perf). Mutually exclusive with `noExpiry: true`. Format is the
   * protobuf Duration JSON encoding — bare seconds with trailing "s".
   */
  ttl?: string;
  /**
   * Strictness for parentBranch lookup. When `parentBranch` is set but the
   * named branch does not exist on the project, the substrate's default is
   * to FALL BACK to the project's default branch with a stderr warning —
   * which keeps the convention-tier defaults
   * (CONVENTION_TIER_DEFAULTS.feature.parentBranch="staging", etc.)
   * usable on projects that don't yet follow the PSA topology.
   *
   * Pass `strictParent: true` to opt OUT of the fallback and throw a
   * typed LakebaseBranchError when the named parent is missing — useful
   * for hotfix-from-production paths where the lineage MUST match the
   * caller's expectation. Default: false (fallback enabled).
   */
  strictParent?: boolean;
}

/**
 * Create a Lakebase branch.
 *
 * Idempotent on a true retry: if a branch with the sanitized name already
 * exists AND its actual source matches the source the caller is asking
 * for now, returns the existing branch. If the existing branch was forked
 * from a *different* source, throws – silently returning a branch with
 * the wrong lineage would mask the user's intent (e.g. they meant to
 * branch from staging this time, but a stale branch from production
 * still occupies the name).
 */
export async function createBranch(args: CreateBranchArgs): Promise<LakebaseBranchInfo> {
  const sanitized = sanitizeBranchName(args.branch);
  const lookup: BranchLookupOpts = { instance: args.instance, host: args.host };

  // Resolve the source (parent) branch full path first – needed both for
  // create AND for the idempotency-vs-conflict comparison below.
  let sourceBranchPath: string | undefined;
  if (args.parentBranch) {
    // Runtime guard: parentBranch must be a BranchName (resource-path
    // leaf), never a BranchUid. The API rejects uids in source_branch
    // with a confusing "branch id not found" error; asBranchName surfaces
    // a typed, helpful message instead.
    if (looksLikeBranchUid(args.parentBranch)) {
      throw new LakebaseBranchError(
        `parentBranch '${args.parentBranch}' looks like a BranchUid (br-… pattern), ` +
          `not a BranchName. Pass the resource-path leaf (e.g. 'production', 'staging', ` +
          `'feature-add-orders') — the Lakebase API rejects uids in source_branch fields. ` +
          `If you have a uid and need to resolve it to its name, call resolveBranchId() ` +
          `from branch-utils first.`
      );
    }
    const validated = asBranchName(args.parentBranch);
    // Verify the named parent ACTUALLY exists on the project. Without this
    // check the substrate previously built the source_branch path via raw
    // string interpolation; the API then errored with the opaque
    // "branch id not found". Now: if the parent exists, use it; if not,
    // fall back to the project default (default behavior) or throw
    // (strictParent: true). This unblocks the CONVENTION_TIER_DEFAULTS
    // path on bare-provisioned projects (which have `production` but no
    // `staging`) while preserving the lineage guarantee for callers who
    // opt into strict mode.
    const parent = await getBranchByName(validated, lookup);
    if (parent) {
      sourceBranchPath = parent.name;
    } else if (args.strictParent === true) {
      throw new LakebaseBranchError(
        `parentBranch '${validated}' does not exist on project '${args.instance}', ` +
          `and strictParent: true was set. Either create '${validated}' first ` +
          `(e.g. cut it off the project default branch) or drop strictParent: true ` +
          `to fall back to the project default branch.`
      );
    } else {
      const def = await getDefaultBranch(lookup);
      if (!def) {
        throw new LakebaseBranchError(
          `parentBranch '${validated}' does not exist on project '${args.instance}' ` +
            `and the project has no default branch to fall back to.`
        );
      }
      const defaultLeaf = leafOf(def.name) ?? def.name;
      process.stderr.write(
        `[lakebase-branch-create] parentBranch '${validated}' not found on project ` +
          `'${args.instance}'; falling back to default branch '${defaultLeaf}'. ` +
          `Pass strictParent: true to throw instead.\n`
      );
      sourceBranchPath = def.name;
    }
  } else if (args.currentBranch && args.currentBranch !== sanitized) {
    const current = await getBranchByName(args.currentBranch, lookup);
    if (current) sourceBranchPath = current.name;
  }
  if (!sourceBranchPath) {
    const def = await getDefaultBranch(lookup);
    if (!def) {
      throw new LakebaseBranchError(
        `Could not find a parent branch for "${sanitized}" – no parentBranch override, ` +
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

  // Expiration policy: ttl wins if set; otherwise default to no_expiry: true.
  // Refuse the inconsistent combination (ttl + noExpiry: true both set).
  if (args.ttl && args.noExpiry === true) {
    throw new LakebaseBranchError(
      `Cannot set both ttl ("${args.ttl}") and noExpiry: true on the same ` +
        `branch — they are mutually exclusive. Pass one or the other.`,
    );
  }
  const specObj: { source_branch: string; no_expiry?: boolean; ttl?: string } = {
    source_branch: sourceBranchPath,
  };
  if (args.ttl) {
    specObj.ttl = args.ttl;
  } else if (args.noExpiry ?? true) {
    specObj.no_expiry = true;
  }
  const spec = JSON.stringify({ spec: specObj });
  try {
    await dbcli(
      ["postgres", "create-branch", projectPath(args.instance), sanitized, "--json", spec],
      args.host
    );
  } catch (err) {
    // Detect the workspace-TTL-policy rejection and rewrap with a typed,
    // actionable message. Other errors bubble through as-is.
    if (err instanceof LakebaseBranchError && specObj.ttl && isTtlTooLongError(err.message)) {
      throw new LakebaseBranchTtlTooLongError(specObj.ttl, err.message);
    }
    throw err;
  }

  return waitForBranchReady({
    instance: args.instance,
    host: args.host,
    branch: sanitized,
    timeoutMs: args.readyTimeoutMs ?? KIT_TIMEOUTS.readyWait,
    pollIntervalMs: args.pollIntervalMs ?? KIT_TIMEOUTS.readyPoll,
  });
}

export interface WaitForBranchReadyArgs extends BranchLookupOpts {
  branch: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Poll until the branch reaches READY state. Throws on timeout. */
export async function waitForBranchReady(args: WaitForBranchReadyArgs): Promise<LakebaseBranchInfo> {
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.readyWait;
  const interval = args.pollIntervalMs ?? KIT_TIMEOUTS.readyPoll;
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
    const { stdout } = await execFileP("databricks", args, { env, timeout: KIT_TIMEOUTS.cliCreateBranch });
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
