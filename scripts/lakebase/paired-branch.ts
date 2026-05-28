// Git-Lakebase paired branch operations.
//
// The substrate's reason for being is keeping a git branch and a Lakebase
// branch in lockstep. These four operations encapsulate the coordination:
//
//   createPairedBranch        – Lakebase branch + matching git branch + .env sync
//   deletePairedBranch        – Lakebase delete + git local + git remote (best-effort)
//   syncEnvToCurrentBranch    – read current git branch, mint fresh credential, update .env
//   checkoutPaired            – in-process equivalent of post-checkout.sh
//                               (trunk/staging/feature modes + parent fallback chain)
//
// Internal git ops use child_process directly. They're NOT exported as a
// generic git-wrapper API – the substrate's charter is Lakebase-aware
// workflow coordination, not a git CLI library. Agents that need raw git
// should shell out to `git` directly.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createBranch, waitForBranchReady } from "./branch-create.js";
import { deleteBranch } from "./branch-delete.js";
import { getBranchByName, getDefaultBranch } from "./branch-utils.js";
import type { LakebaseBranchInfo } from "./branch-utils.js";
import {
  endpointPath,
  ensureEndpoint,
  getCredential,
  getEndpoint,
} from "./branch-endpoint.js";
import { mintCredential } from "./get-connection.js";
import { sanitizeBranchName } from "../util/sanitize-branch-name.js";
import { updateEnvConnection } from "./env-file.js";
import { DEFAULT_DATABASE, POSTGRES_PORT } from "./constants.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

// ─── Internal git helpers ───────────────────────────────────────

function gitCurrentBranch(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KIT_TIMEOUTS.gitDefault,
  }).trim();
}

function gitHasLocalBranch(cwd: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      stdio: "ignore",
      timeout: KIT_TIMEOUTS.gitDefault,
    });
    return true;
  } catch {
    return false;
  }
}

function gitCheckoutNewBranch(cwd: string, branch: string): void {
  execFileSync("git", ["checkout", "-b", branch], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KIT_TIMEOUTS.gitCheckout,
  });
}

function gitCheckoutExistingBranch(cwd: string, branch: string): void {
  execFileSync("git", ["checkout", branch], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KIT_TIMEOUTS.gitCheckout,
  });
}

function gitDeleteLocalBranch(cwd: string, branch: string, force = true): void {
  execFileSync("git", ["branch", force ? "-D" : "-d", branch], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KIT_TIMEOUTS.gitDefault,
  });
}

function gitHasRemoteBranch(cwd: string, remote: string, branch: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["ls-remote", "--exit-code", "--heads", remote, branch],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: KIT_TIMEOUTS.gitNetwork }
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function gitDeleteRemoteBranch(cwd: string, remote: string, branch: string): void {
  execFileSync("git", ["push", remote, "--delete", branch], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KIT_TIMEOUTS.gitPush,
  });
}

function readEnvVar(envPath: string, key: string): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, "utf-8");
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function buildDsn(host: string, database: string, user: string, password: string): string {
  const u = new URL(`postgresql://${host}:${POSTGRES_PORT}/${encodeURIComponent(database)}`);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  u.searchParams.set("sslmode", "require");
  return u.toString();
}

// ─── createPairedBranch ────────────────────────────────────────

export interface CreatePairedBranchArgs {
  instance: string;
  branch: string;
  /** Explicit Lakebase parent override. */
  parentBranch?: string;
  /** Project directory (must contain .git/; .env is updated if syncEnv=true). */
  cwd: string;
  /** Create+switch a git branch with the same sanitized name. Default: true. */
  createGitBranch?: boolean;
  /** Update .env to point at the new branch's endpoint. Default: true. */
  syncEnv?: boolean;
  /** Default: 120_000. Lakebase ready-state poll budget. */
  readyTimeoutMs?: number;
  /** Default: "databricks_postgres". */
  database?: string;
}

export interface CreatePairedBranchResult {
  branch: LakebaseBranchInfo;
  /** Sanitized git branch name (matches Lakebase branch name). */
  gitBranch: string;
  /** True iff the git branch was newly created in this call. */
  gitBranchCreated: boolean;
  /** True iff .env was updated with fresh credentials. */
  envSynced: boolean;
  /** Non-fatal issues collected during the run. */
  warnings: string[];
}

/**
 * Create a Lakebase branch + matching git branch + .env sync, in one call.
 *
 * Order:
 *   1. Create Lakebase branch (sanitized name)
 *   2. Wait for READY (so the endpoint exists when we sync .env)
 *   3. Create git branch with the same sanitized name (if createGitBranch)
 *   4. Mint credential + update .env (if syncEnv)
 *
 * Failures after step 1 are NOT rolled back – the Lakebase branch survives
 * and the caller can retry. Warnings collect non-fatal step failures.
 */
export async function createPairedBranch(
  args: CreatePairedBranchArgs
): Promise<CreatePairedBranchResult> {
  const warnings: string[] = [];
  const sanitized = sanitizeBranchName(args.branch);
  const createGitBranch = args.createGitBranch !== false;
  const syncEnv = args.syncEnv !== false;
  const database = args.database ?? process.env.PGDATABASE ?? DEFAULT_DATABASE;

  // 1. Create Lakebase branch (idempotent if already exists with same name)
  const branch = await createBranch({
    instance: args.instance,
    branch: args.branch,
    parentBranch: args.parentBranch,
  });

  // 2. Wait for READY (createBranch already polls, but make budget explicit)
  let ready = branch;
  if (branch.state !== "READY") {
    try {
      ready = await waitForBranchReady({
        instance: args.instance,
        branch: sanitized,
        timeoutMs: args.readyTimeoutMs ?? KIT_TIMEOUTS.readyWait,
      });
    } catch (err) {
      warnings.push(
        `Lakebase branch created but did not reach READY: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 3. Create+switch git branch
  let gitBranchCreated = false;
  if (createGitBranch) {
    try {
      if (gitHasLocalBranch(args.cwd, sanitized)) {
        gitCheckoutExistingBranch(args.cwd, sanitized);
      } else {
        gitCheckoutNewBranch(args.cwd, sanitized);
        gitBranchCreated = true;
      }
    } catch (err) {
      warnings.push(
        `Failed to create/switch git branch "${sanitized}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 4. Sync .env with fresh credentials
  let envSynced = false;
  if (syncEnv && ready.state === "READY") {
    try {
      const ep = await getEndpoint({ instance: args.instance, branch: sanitized });
      if (!ep?.host) {
        warnings.push(`Endpoint not yet available for "${sanitized}" – .env not updated`);
      } else {
        const { token, email } = await mintCredential(endpointPath(args.instance, sanitized));
        const dsn = buildDsn(ep.host, database, email, token);
        updateEnvConnection({
          envPath: path.join(args.cwd, ".env"),
          branchId: sanitized,
          databaseUrl: dsn,
          username: email,
          password: token,
          endpointHost: ep.host,
        });
        envSynced = true;
      }
    } catch (err) {
      warnings.push(
        `.env sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    branch: ready,
    gitBranch: sanitized,
    gitBranchCreated,
    envSynced,
    warnings,
  };
}

// ─── deletePairedBranch ────────────────────────────────────────

export interface DeletePairedBranchArgs {
  instance: string;
  branch: string;
  /** Project directory (must contain .git/). */
  cwd: string;
  /** Delete the local git branch. Default: true. Skipped if branch is currently checked out. */
  deleteGitLocal?: boolean;
  /** Delete the remote git branch if it exists. Default: true. */
  deleteGitRemote?: boolean;
  /** Remote name. Default: "origin". */
  gitRemote?: string;
}

export interface DeletePairedBranchResult {
  lakebaseDeleted: boolean;
  gitLocalDeleted: boolean;
  gitRemoteDeleted: boolean;
  warnings: string[];
}

/**
 * Delete the Lakebase branch + matching git branch (local + remote).
 *
 * Best-effort: each side is attempted independently and failures land in
 * `warnings[]`. The function never throws – returns a status of each side.
 * Useful for the extension's "delete branch everywhere" command and for
 * agent-driven cleanup.
 */
export async function deletePairedBranch(
  args: DeletePairedBranchArgs
): Promise<DeletePairedBranchResult> {
  const warnings: string[] = [];
  const sanitized = sanitizeBranchName(args.branch);
  const deleteGitLocal = args.deleteGitLocal !== false;
  const deleteGitRemote = args.deleteGitRemote !== false;
  const gitRemote = args.gitRemote ?? "origin";

  // Lakebase delete
  let lakebaseDeleted = false;
  try {
    await deleteBranch({ instance: args.instance, branch: sanitized });
    lakebaseDeleted = true;
  } catch (err) {
    warnings.push(
      `Lakebase delete failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Git local delete (skip if current branch – would orphan HEAD)
  let gitLocalDeleted = false;
  if (deleteGitLocal) {
    try {
      const current = gitCurrentBranch(args.cwd);
      if (current === sanitized) {
        warnings.push(`Skipped local git delete: branch "${sanitized}" is currently checked out`);
      } else if (!gitHasLocalBranch(args.cwd, sanitized)) {
        // No-op – already not present
        gitLocalDeleted = true;
      } else {
        gitDeleteLocalBranch(args.cwd, sanitized, true);
        gitLocalDeleted = true;
      }
    } catch (err) {
      warnings.push(
        `Local git delete failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Git remote delete
  let gitRemoteDeleted = false;
  if (deleteGitRemote) {
    try {
      if (gitHasRemoteBranch(args.cwd, gitRemote, sanitized)) {
        gitDeleteRemoteBranch(args.cwd, gitRemote, sanitized);
        gitRemoteDeleted = true;
      } else {
        // No-op – already not present
        gitRemoteDeleted = true;
      }
    } catch (err) {
      warnings.push(
        `Remote git delete failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { lakebaseDeleted, gitLocalDeleted, gitRemoteDeleted, warnings };
}

// ─── syncEnvToCurrentBranch ────────────────────────────────────

export interface SyncEnvArgs {
  /** Project directory (must contain .env and .git/). */
  cwd: string;
  /** Override the Lakebase instance id. Default: read LAKEBASE_PROJECT_ID from .env. */
  instance?: string;
  /** Override the branch name. Default: use current git branch (sanitized). */
  branch?: string;
  /** Default: "databricks_postgres". */
  database?: string;
}

export interface SyncEnvResult {
  /** Sanitized branch name we synced to. */
  branchId: string;
  endpointHost: string;
  databaseUrl: string;
}

/**
 * Read current git branch (or honor the `branch` override), look up the
 * matching Lakebase branch's endpoint, mint a fresh credential, and update
 * .env. This is the in-process equivalent of templates/.../post-checkout.sh,
 * usable from any agent.
 *
 * Throws when:
 *   - .env doesn't exist or doesn't declare LAKEBASE_PROJECT_ID (and no
 *     `instance` override was passed)
 *   - the Lakebase branch's endpoint has no host yet (still provisioning)
 *   - credential minting fails (auth expired, etc.)
 */
export async function syncEnvToCurrentBranch(args: SyncEnvArgs): Promise<SyncEnvResult> {
  const envPath = path.join(args.cwd, ".env");
  const instance =
    args.instance ?? readEnvVar(envPath, "LAKEBASE_PROJECT_ID");
  if (!instance) {
    throw new Error(
      `Could not resolve Lakebase instance id (set LAKEBASE_PROJECT_ID in .env or pass --instance)`
    );
  }
  const rawBranch = args.branch ?? gitCurrentBranch(args.cwd);
  const sanitized = sanitizeBranchName(rawBranch);
  const database = args.database ?? process.env.PGDATABASE ?? DEFAULT_DATABASE;

  const ep = await getEndpoint({ instance, branch: sanitized });
  if (!ep?.host) {
    throw new Error(
      `No endpoint host yet for branch "${sanitized}" in instance "${instance}" – branch may still be provisioning`
    );
  }
  const { token, email } = await getCredential({ instance, branch: sanitized });
  const dsn = buildDsn(ep.host, database, email, token);

  updateEnvConnection({
    envPath,
    branchId: sanitized,
    databaseUrl: dsn,
    username: email,
    password: token,
    endpointHost: ep.host,
  });

  return { branchId: sanitized, endpointHost: ep.host, databaseUrl: dsn };
}

// ─── checkoutPaired ────────────────────────────────────────────

export type CheckoutMode = "trunk" | "staging" | "feature" | "feature-created";

export interface CheckoutPairedArgs {
  /** Project directory (must contain .env). */
  cwd: string;
  /** Target git branch. Default: read current via `git rev-parse --abbrev-ref HEAD`. */
  branch?: string;
  /** Lakebase instance. Default: read LAKEBASE_PROJECT_ID from .env. */
  instance?: string;
  /**
   * Override: when the current git branch equals this name, pair with the
   * project's default Lakebase branch. Mirrors LAKEBASE_TRUNK_BRANCH from
   * the post-checkout hook. Default: no alias – uses main/master.
   */
  trunkAlias?: string;
  /**
   * Override: when the current git branch equals this name, pair with the
   * Lakebase `staging` branch (which must already exist; this function does
   * NOT auto-create it). Mirrors LAKEBASE_STAGING_BRANCH.
   */
  stagingAlias?: string;
  /**
   * Pinned base branch for feature mode. Mirrors LAKEBASE_BASE_BRANCH. When
   * set, new feature branches always fork from this branch instead of using
   * the "branch I was just on" hint.
   */
  baseBranch?: string;
  /**
   * Previous Lakebase branch (the value of LAKEBASE_BRANCH_ID in .env BEFORE
   * the git checkout). Used as the 2nd-precedence parent in feature mode.
   * When omitted, this is read from .env automatically.
   */
  previousBranch?: string;
  /** When the target feature branch doesn't exist on Lakebase, create it. Default: true. */
  autoCreate?: boolean;
  /** Default: "databricks_postgres". */
  database?: string;
  /** Lakebase branch ready-state poll budget. Default: 120_000. */
  readyTimeoutMs?: number;
}

export interface CheckoutPairedResult {
  /** Sanitized branch name on the Lakebase side. */
  branchId: string;
  /** Which mode resolved. */
  mode: CheckoutMode;
  /** The Lakebase branch we actually paired against (may differ from branchId
   *  in trunk/staging modes where the alias maps to a fixed Lakebase name). */
  matchedLakebaseBranch: string;
  /** Endpoint host the .env now points at. */
  endpointHost: string;
  /** Full DSN written into .env. */
  databaseUrl: string;
  /** True iff .env was rewritten. */
  envUpdated: boolean;
  /** Non-fatal issues collected during the run. */
  warnings: string[];
}

/**
 * In-process equivalent of the bundled `post-checkout.sh` hook.
 *
 * Use when an agent is driving a paired project programmatically without
 * relying on the git hook to fire (e.g. an agent that doesn't shell out to
 * `git checkout`, or a recovery path when the hook isn't installed). For
 * developers running `git checkout` in a terminal, the hook handles this
 * automatically – calling checkoutPaired then is redundant.
 *
 * Mirrors the hook's three-mode logic and parent fallback chain:
 *
 *   1. **trunk** – current branch == `trunkAlias` (or main/master if no
 *      alias). Pairs .env with the project's default Lakebase branch.
 *   2. **staging** – current branch == `stagingAlias`. Pairs .env with the
 *      Lakebase `staging` branch IF it already exists; does NOT auto-create.
 *   3. **feature** – anything else. Auto-creates a Lakebase branch with the
 *      same sanitized name, using parent precedence:
 *        a. `baseBranch` arg (pinned 3-tier base)
 *        b. `previousBranch` arg / LAKEBASE_BRANCH_ID from .env, if that
 *           branch still exists on Lakebase
 *        c. Project default branch
 *
 * After resolving the Lakebase branch, ensures its endpoint exists (creates
 * one with autoscaling 2-4 CU if missing), mints a fresh credential, and
 * rewrites the .env connection block. The git checkout itself is NOT
 * performed – caller is responsible for that side (either `git checkout`
 * before calling, or rely on the hook firing after `git checkout`).
 */
export async function checkoutPaired(args: CheckoutPairedArgs): Promise<CheckoutPairedResult> {
  const warnings: string[] = [];
  const envPath = path.join(args.cwd, ".env");

  // 1. Resolve instance
  const instance = args.instance ?? readEnvVar(envPath, "LAKEBASE_PROJECT_ID");
  if (!instance) {
    throw new Error(
      `Could not resolve Lakebase instance (set LAKEBASE_PROJECT_ID in .env or pass --instance)`
    );
  }

  // 2. Resolve target branch
  const rawBranch = args.branch ?? gitCurrentBranch(args.cwd);
  if (!rawBranch || rawBranch === "HEAD") {
    throw new Error(
      `Cannot resolve current git branch (detached HEAD or not a git repo at ${args.cwd})`
    );
  }
  const branchId = sanitizeBranchName(rawBranch);
  const database = args.database ?? process.env.PGDATABASE ?? DEFAULT_DATABASE;

  // 3. Resolve "previous Lakebase branch" – caller arg wins over .env
  const previousBranch =
    args.previousBranch ?? readEnvVar(envPath, "LAKEBASE_BRANCH_ID") ?? "";

  // 4. Determine mode
  const trunkAlias = args.trunkAlias?.trim();
  const stagingAlias = args.stagingAlias?.trim();
  let mode: CheckoutMode = "feature";
  let lakebaseBranch = branchId;

  const isTrunkAlias = trunkAlias && rawBranch === trunkAlias;
  const isMainOrMaster = !trunkAlias && (rawBranch === "main" || rawBranch === "master");
  const isStagingAlias = stagingAlias && rawBranch === stagingAlias;

  if (isTrunkAlias || isMainOrMaster) {
    mode = "trunk";
    const def = await getDefaultBranch({ instance });
    if (!def) {
      throw new Error(
        `Could not resolve default Lakebase branch for instance "${instance}"`
      );
    }
    lakebaseBranch = def.name.split("/branches/").pop() ?? def.uid;
  } else if (isStagingAlias) {
    mode = "staging";
    const staging = await getBranchByName("staging", { instance });
    if (!staging) {
      warnings.push(
        `On git branch "${rawBranch}" (staging alias) but Lakebase "staging" branch does not exist. ` +
          `It must be bootstrapped deliberately – this function does not auto-create it.`
      );
      // Don't update .env when staging is missing – return a hollow result
      return {
        branchId,
        mode,
        matchedLakebaseBranch: "staging",
        endpointHost: "",
        databaseUrl: "",
        envUpdated: false,
        warnings,
      };
    }
    lakebaseBranch = "staging";
  } else {
    // Feature mode – find or create the Lakebase branch with parent fallback
    let existing = await getBranchByName(branchId, { instance });
    if (!existing) {
      if (args.autoCreate !== false) {
        const parentBranch = await resolveFeatureParent({
          instance,
          target: branchId,
          baseBranch: args.baseBranch,
          previousBranch,
        });
        const created = await createBranch({
          instance,
          branch: rawBranch,
          parentBranch,
        });
        if (created.state !== "READY") {
          try {
            await waitForBranchReady({
              instance,
              branch: branchId,
              timeoutMs: args.readyTimeoutMs ?? KIT_TIMEOUTS.readyWait,
            });
          } catch (err) {
            warnings.push(
              `Lakebase branch created but did not reach READY: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        existing = await getBranchByName(branchId, { instance });
        mode = "feature-created";
      } else {
        throw new Error(
          `Lakebase branch "${branchId}" does not exist and autoCreate=false`
        );
      }
    }
    lakebaseBranch = branchId;
  }

  // 5. Ensure endpoint, mint credential, write .env
  const ep = await ensureEndpoint({
    instance,
    branch: lakebaseBranch,
    timeoutMs: args.readyTimeoutMs ?? KIT_TIMEOUTS.readyWait,
  });
  const { token, email } = await mintCredential(endpointPath(instance, lakebaseBranch));
  const dsn = buildDsn(ep.host, database, email, token);
  updateEnvConnection({
    envPath,
    branchId: lakebaseBranch,
    databaseUrl: dsn,
    username: email,
    password: token,
    endpointHost: ep.host,
  });

  return {
    branchId,
    mode,
    matchedLakebaseBranch: lakebaseBranch,
    endpointHost: ep.host,
    databaseUrl: dsn,
    envUpdated: true,
    warnings,
  };
}

/** Internal: 3-step parent resolution for feature mode. Mirrors post-checkout.sh. */
async function resolveFeatureParent(args: {
  instance: string;
  target: string;
  baseBranch?: string;
  previousBranch: string;
}): Promise<string | undefined> {
  // 1. Pinned base
  if (args.baseBranch) {
    return args.baseBranch;
  }
  // 2. Previous branch (if it still exists)
  if (args.previousBranch && args.previousBranch !== args.target) {
    const prev = await getBranchByName(args.previousBranch, { instance: args.instance });
    if (prev) {
      return args.previousBranch;
    }
  }
  // 3. Project default (handled by createBranch when parentBranch is undefined)
  return undefined;
}
