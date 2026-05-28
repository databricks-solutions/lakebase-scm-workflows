// Lakebase project CRUD – the create / delete / default-branch-lookup
// subset of LakebaseService that create-project needs. Other LakebaseService
// concerns (endpoints, credential minting, schema querying) live in
// scripts/lakebase/get-connection.ts (FEIP-7061) and other verbs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { branchNameFromResourcePath, type BranchName } from "./branch-id.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

const execFileP = promisify(execFile);

export class LakebaseProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LakebaseProjectError";
  }
}

export interface LakebaseProjectInfo {
  /** Project UID as Lakebase reports it (often matches the projectId). */
  uid: string;
  /** Fully-qualified resource name, e.g. "projects/my-app". */
  name: string;
  /** Current lifecycle state (e.g. "READY"). */
  state: string;
}

export interface LakebaseProjectArgs {
  /** Project id (becomes the local directory name + Lakebase identifier). */
  projectId: string;
  /** Optional DATABRICKS_HOST override; otherwise CLI's default config is used. */
  host?: string;
}

/**
 * Create a Lakebase project via `databricks postgres create-project`.
 * Long-running on the server side; the CLI waits for completion.
 */
export async function createLakebaseProject(args: LakebaseProjectArgs): Promise<LakebaseProjectInfo> {
  const raw = await dbcli(["postgres", "create-project", args.projectId, "-o", "json"], args.host);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new LakebaseProjectError(`Unexpected CLI output (not JSON): ${raw.slice(0, 200)}`);
  }
  const result =
    (parsed.response as Record<string, unknown> | undefined) ??
    (parsed.result as Record<string, unknown> | undefined) ??
    parsed;
  const status = (result.status as { current_state?: string } | undefined) ?? undefined;
  return {
    uid: (result.uid as string) ?? args.projectId,
    name: (result.name as string) ?? `projects/${args.projectId}`,
    state: status?.current_state ?? (result.state as string) ?? "READY",
  };
}

/**
 * Delete a Lakebase project via `databricks postgres delete-project`.
 * Long-running on the server side; the CLI waits for completion.
 */
export async function deleteLakebaseProject(args: LakebaseProjectArgs): Promise<void> {
  const name = args.projectId.startsWith("projects/") ? args.projectId : `projects/${args.projectId}`;
  await dbcli(["postgres", "delete-project", name, "-o", "json"], args.host);
}

/**
 * Resolve the default branch id for a freshly-created Lakebase project.
 * Returns the empty string if the default branch isn't ready yet (the
 * extension treats that as non-fatal in createProject step 4).
 */
/**
 * Resolve the project's default branch and return its {@link BranchName}
 * (the resource-path leaf, e.g. `production`), NOT its {@link BranchUid}.
 *
 * Why this returns BranchName specifically: every API field that takes a
 * branch reference — `source_branch` in create-branch specs, the
 * `{branch}` segment in `branches/{x}/endpoints/...` URLs, .env
 * LAKEBASE_BRANCH_NAME — wants the path leaf, not the uid. Returning a
 * uid here (the prior contract under the misleading name
 * `getDefaultBranchId`) caused a "branch id not found" error from the
 * service when the value was substituted into source_branch.
 *
 * Returns null when the project has no default branch or the CLI errored.
 */
/**
 * Pure helper: extract the default branch's BranchName from a parsed
 * list-branches response. Exported so the regression contract is
 * directly unit-testable without mocking the Databricks CLI.
 *
 * Always derives from `name`, never from `uid`. A BranchUid in this slot
 * would be silently wrong: the API rejects uids in path-shaped fields
 * (which is the only place this function's return value belongs).
 */
export function findDefaultBranchName(items: BranchMetadata[]): BranchName | null {
  const def = items.find((b) => b.status?.default === true || b.is_default === true);
  if (!def || !def.name) return null;
  return branchNameFromResourcePath(def.name);
}

export async function getDefaultBranchName(
  args: LakebaseProjectArgs
): Promise<BranchName | null> {
  try {
    const raw = await dbcli(
      ["postgres", "list-branches", `projects/${args.projectId}`, "-o", "json"],
      args.host
    );
    const parsed = JSON.parse(raw) as
      | Array<BranchMetadata>
      | { branches?: BranchMetadata[]; items?: BranchMetadata[] };
    const items: BranchMetadata[] = Array.isArray(parsed)
      ? parsed
      : parsed.branches ?? parsed.items ?? [];
    return findDefaultBranchName(items);
  } catch {
    return null;
  }
}

/**
 * @deprecated Renamed to {@link getDefaultBranchName}. The old name was
 * ambiguous ("Id" of what?) and the old implementation returned the
 * BranchUid, which is wrong for every caller that passes it into a
 * path-shaped API field. This shim now returns the BranchName as a bare
 * string for transitional callers; remove after the next major bump.
 */
export async function getDefaultBranchId(args: LakebaseProjectArgs): Promise<string> {
  const name = await getDefaultBranchName(args);
  return name ?? "";
}

export interface BranchMetadata {
  uid?: string;
  name?: string;
  status?: { default?: boolean };
  is_default?: boolean;
}

export interface LakebaseProjectMetadata {
  uid: string;
  name: string;
  displayName?: string;
  state?: string;
}

/**
 * Look up a Lakebase project's metadata (uid, display name, state).
 * Returns undefined when the project doesn't exist or the CLI errors.
 */
export async function getProjectInfo(args: LakebaseProjectArgs): Promise<LakebaseProjectMetadata | undefined> {
  const name = args.projectId.startsWith("projects/") ? args.projectId : `projects/${args.projectId}`;
  let raw: string;
  try {
    raw = await dbcli(["postgres", "get-project", name, "-o", "json"], args.host);
  } catch {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const status = (parsed.status as { current_state?: string } | undefined) ?? undefined;
  return {
    uid: (parsed.uid as string) ?? args.projectId,
    name: (parsed.name as string) ?? name,
    displayName: (parsed.display_name as string) ?? (parsed.displayName as string) ?? undefined,
    state: status?.current_state ?? (parsed.state as string) ?? undefined,
  };
}

async function dbcli(args: string[], host?: string): Promise<string> {
  const trimmedHost = host?.replace(/\/+$/, "");
  const env = trimmedHost ? { ...process.env, DATABRICKS_HOST: trimmedHost } : process.env;
  try {
    const { stdout } = await execFileP("databricks", args, {
      env: env as NodeJS.ProcessEnv,
      timeout: KIT_TIMEOUTS.cliDefault,
    });
    return stdout.toString();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf8")
          : "";
    throw new LakebaseProjectError(
      `databricks ${args.join(" ")} failed: ${e.message}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`
    );
  }
}
