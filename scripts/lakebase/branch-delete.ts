// Delete a Lakebase branch by uid, branchId, or full resource name.
// The CLI requires the full resource name (projects/.../branches/...);
// this module looks it up first.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  LakebaseBranchError,
  BranchLookupOpts,
  resolveBranchPath,
} from "./branch-utils.js";

const execFileP = promisify(execFile);

export interface DeleteBranchArgs extends BranchLookupOpts {
  /** Branch uid, branchId, or full resource name. */
  branch: string;
}

/**
 * Delete a Lakebase branch. Throws when the branch can't be resolved
 * (no silent no-op – caller should catch + ignore if they want
 * idempotent semantics).
 */
export async function deleteBranch(args: DeleteBranchArgs): Promise<void> {
  const fullPath = await resolveBranchPath(args.branch, {
    instance: args.instance,
    host: args.host,
  });
  if (!fullPath) {
    throw new LakebaseBranchError(`Branch "${args.branch}" not found in instance "${args.instance}"`);
  }
  await dbcli(["postgres", "delete-branch", fullPath], args.host);
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
