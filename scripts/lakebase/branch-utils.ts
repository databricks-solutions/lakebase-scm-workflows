// Lakebase branch lookup helpers. Subset of LakebaseService ported for
// the branch-lifecycle ops (create / delete; checkout follows in FEIP-7063a).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class LakebaseBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LakebaseBranchError";
  }
}

export interface LakebaseBranchInfo {
  /**
   * Lakebase-side opaque uid, e.g. "br-broad-sky-d2k5gewt". Returned by
   * `get-branch` / `list-branches` as the `uid` field. NOT accepted as the
   * `{branch}` path segment in CLI subresource URLs — use {@link branchId} or
   * the friendly leaf of {@link name} for those.
   */
  uid: string;
  /** Full resource name, e.g. "projects/proj-abc/branches/feature-x". */
  name: string;
  /** "READY", "PROVISIONING", etc. */
  state: string;
  /**
   * Parent branch full resource name (e.g. "projects/x/branches/staging"),
   * sourced from `status.source_branch` in the Lakebase API response.
   *
   * Use {@link sourceBranchId} for just the leaf segment.
   */
  sourceBranchName?: string;
  /** Parent branch leaf id (e.g. "staging"). Derived from sourceBranchName. */
  sourceBranchId?: string;
  /** True if this is the project's default branch. */
  isDefault?: boolean;
  /**
   * RFC3339 expiration, e.g. "2026-06-25T05:00:00Z". Present for branches
   * created with a TTL (workflow tiers feature / test / uat / perf). Absent
   * for long-running tiers (production / staging) and for legacy branches
   * created with `no_expiry: true`.
   */
  expireTime?: string;
  /** True if the branch is protected from deletion. */
  isProtected?: boolean;
}

export interface BranchLookupOpts {
  /** Lakebase project id. */
  instance: string;
  /** Optional DATABRICKS_HOST override. */
  host?: string;
}

/** Build the canonical project path. */
export function projectPath(instance: string): string {
  return `projects/${instance}`;
}

/** List all branches for a Lakebase project. */
export async function listBranches(opts: BranchLookupOpts): Promise<LakebaseBranchInfo[]> {
  const raw = await dbcli(
    ["postgres", "list-branches", projectPath(opts.instance), "-o", "json"],
    opts.host
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LakebaseBranchError(`Unexpected CLI output: ${raw.slice(0, 200)}`);
  }
  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : ((parsed as { branches?: unknown[]; items?: unknown[] }).branches ??
        (parsed as { items?: unknown[] }).items ??
        []);
  return items.map(parseBranch).filter((b): b is LakebaseBranchInfo => b !== undefined);
}

/** Find a branch by uid, branchId, or full resource name. */
export async function getBranchByName(
  branchNameOrUid: string,
  opts: BranchLookupOpts
): Promise<LakebaseBranchInfo | undefined> {
  const branches = await listBranches(opts);
  return branches.find(
    (b) =>
      b.uid === branchNameOrUid ||
      b.name === branchNameOrUid ||
      b.name.endsWith(`/${branchNameOrUid}`)
  );
}

/** Get the project's default branch (or undefined if none is marked default). */
export async function getDefaultBranch(opts: BranchLookupOpts): Promise<LakebaseBranchInfo | undefined> {
  const branches = await listBranches(opts);
  return branches.find((b) => b.isDefault);
}

/**
 * Resolve a branch reference to its full resource name (projects/.../branches/...).
 * Returns undefined when the branch can't be found.
 */
export async function resolveBranchPath(
  branchNameOrUid: string,
  opts: BranchLookupOpts
): Promise<string | undefined> {
  if (branchNameOrUid.startsWith("projects/") && branchNameOrUid.includes("/branches/")) {
    return branchNameOrUid;
  }
  const branch = await getBranchByName(branchNameOrUid, opts);
  return branch?.name;
}

/**
 * Normalize a branch reference to the friendly `branch_id` (leaf segment,
 * e.g. "demo-feature", "staging", "production"). This is the form accepted
 * by CLI subresource URLs like `branches/{x}/endpoints/primary`.
 *
 * Accepts any of:
 *   - branch_id ("demo-feature", or any PSA tier name: "production",
 *     "staging", "uat", "perf")
 *   - branch_uid ("br-broad-sky-d2k5gewt")
 *   - full resource path ("projects/x/branches/demo-feature")
 *
 * Throws when the branch can't be resolved (e.g. uid points at nothing).
 * Fast-path: returns input unchanged for values that don't look like a uid
 * (no `br-` prefix) and don't include a path prefix — avoids a round-trip
 * for the common branch_id case.
 */
export async function resolveBranchId(
  args: BranchLookupOpts & { branch: string }
): Promise<string> {
  const { branch, ...opts } = args;

  // Full resource path → take the leaf.
  if (branch.startsWith("projects/") && branch.includes("/branches/")) {
    const leaf = branch.split("/branches/").pop();
    if (leaf) return leaf;
  }

  // Fast path: looks like a branch_id already (no uid prefix). Trust it.
  if (!branch.startsWith("br-")) {
    return branch;
  }

  // Slow path: uid → list + filter to get the friendly id.
  const info = await getBranchByName(branch, opts);
  if (!info) {
    throw new LakebaseBranchError(
      `Could not resolve branch "${branch}" in project "${opts.instance}". ` +
        `Pass either the branch_id (e.g. "demo-feature") or the branch uid.`
    );
  }
  const leaf = info.name.split("/branches/").pop();
  if (!leaf) {
    throw new LakebaseBranchError(
      `Branch info for "${branch}" missing a name segment (got "${info.name}").`
    );
  }
  return leaf;
}

// ── Internal ────────────────────────────────────────────────────

interface RawBranch {
  uid?: string;
  name?: string;
  state?: string;
  status?: {
    current_state?: string;
    default?: boolean;
    /**
     * Lakebase returns the parent branch's full resource name here on
     * `get-branch` responses. Older speculation was `spec.source_branch`
     * (kept as a fallback for backward compatibility / list-branches shapes
     * we haven't seen yet).
     */
    source_branch?: string;
    expire_time?: string;
    is_protected?: boolean;
  };
  is_default?: boolean;
  spec?: { source_branch?: string };
}

function parseBranch(raw: unknown): LakebaseBranchInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as RawBranch;
  const name = r.name ?? "";
  if (!name) return undefined;
  const uid = r.uid ?? name.split("/branches/").pop() ?? "";
  const sourceBranchName = r.status?.source_branch ?? r.spec?.source_branch;
  const sourceBranchId = sourceBranchName?.split("/branches/").pop() || undefined;
  return {
    uid,
    name,
    state: r.status?.current_state ?? r.state ?? "UNKNOWN",
    sourceBranchName,
    sourceBranchId,
    isDefault: r.status?.default === true || r.is_default === true,
    expireTime: r.status?.expire_time,
    isProtected: r.status?.is_protected,
  };
}

async function dbcli(args: string[], host?: string): Promise<string> {
  const trimmedHost = host?.replace(/\/+$/, "");
  const env = trimmedHost
    ? ({ ...process.env, DATABRICKS_HOST: trimmedHost } as NodeJS.ProcessEnv)
    : process.env;
  try {
    const { stdout } = await execFileP("databricks", args, { env, timeout: 30_000 });
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
