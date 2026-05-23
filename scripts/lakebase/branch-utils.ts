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
  /** Lakebase-side branch id (often equals the sanitized git branch). */
  uid: string;
  /** Full resource name, e.g. "projects/proj-abc/branches/feature-x". */
  name: string;
  /** "READY", "PROVISIONING", etc. */
  state: string;
  /** Parent branch full name (from spec.source_branch). */
  sourceBranchName?: string;
  /** True if this is the project's default branch. */
  isDefault?: boolean;
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

// ── Internal ────────────────────────────────────────────────────

interface RawBranch {
  uid?: string;
  name?: string;
  state?: string;
  status?: { current_state?: string; default?: boolean };
  is_default?: boolean;
  spec?: { source_branch?: string };
}

function parseBranch(raw: unknown): LakebaseBranchInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as RawBranch;
  const name = r.name ?? "";
  if (!name) return undefined;
  const uid = r.uid ?? name.split("/branches/").pop() ?? "";
  return {
    uid,
    name,
    state: r.status?.current_state ?? r.state ?? "UNKNOWN",
    sourceBranchName: r.spec?.source_branch,
    isDefault: r.status?.default === true || r.is_default === true,
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
