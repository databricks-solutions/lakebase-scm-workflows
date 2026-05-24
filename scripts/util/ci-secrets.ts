// Sync CI secrets (DATABRICKS_HOST, LAKEBASE_PROJECT_ID, DATABRICKS_TOKEN)
// to the GitHub repo. Mints a fresh Databricks PAT.
//
// Caller passes the values directly. Previously this read .env from disk,
// but since createProject no longer writes .env (option 3 – the only on-disk
// .env is created later by the post-checkout hook, after CI secrets need to
// be set), the values have to come from the create-project caller's scope.

import { exec } from "./exec.js";
import { setRepoSecrets } from "../github/secrets.js";
import { getOwnerRepo } from "../git/remote.js";

export interface SyncCiSecretsArgs {
  /** Project root (used to resolve ownerRepo from `git remote` when not given,
   *  and as the cwd for the `databricks tokens create` call). */
  projectDir: string;
  /** Workspace host (DATABRICKS_HOST secret). Required. */
  databricksHost: string;
  /** Lakebase project id (LAKEBASE_PROJECT_ID secret). Required. */
  lakebaseProjectId: string;
  /** Token comment for `databricks tokens create`. */
  comment?: string;
  /** Token lifetime in seconds (default: 24h). */
  lifetimeSeconds?: number;
  /** Override the auto-detected ownerRepo (defaults to origin remote). */
  ownerRepo?: string;
}

/** Synchronize Databricks + Lakebase CI secrets to the repo's Actions secrets. */
export async function syncCiSecrets(args: SyncCiSecretsArgs): Promise<void> {
  const lifetime = args.lifetimeSeconds ?? 86_400;
  const comment = args.comment ?? "GitHub Actions CI";

  const ownerRepo = args.ownerRepo ?? (await getOwnerRepo(args.projectDir));
  if (!ownerRepo) {
    throw new Error("Could not resolve GitHub repository from git remote");
  }
  if (!args.databricksHost) {
    throw new Error("syncCiSecrets: databricksHost is required");
  }
  if (!args.lakebaseProjectId) {
    throw new Error("syncCiSecrets: lakebaseProjectId is required");
  }

  const secrets: Record<string, string> = {
    DATABRICKS_HOST: args.databricksHost,
    LAKEBASE_PROJECT_ID: args.lakebaseProjectId,
  };

  // Mint a fresh PAT for CI. If this fails, ship the non-secret pair anyway –
  // a partially-configured repo is still better than nothing (the user can
  // re-mint via the in-project refresh-token script), and the caller logs the
  // warning. Auth workflows will fail loudly with a clear message until then.
  try {
    const tokenRaw = await exec(
      `databricks tokens create --comment "${comment}" --lifetime-seconds ${lifetime} -o json`,
      { cwd: args.projectDir, timeout: 30_000, env: { DATABRICKS_HOST: args.databricksHost } }
    );
    const parsed = JSON.parse(tokenRaw);
    const token = parsed.token_value || parsed.token || "";
    if (token) secrets.DATABRICKS_TOKEN = token;
  } catch {
    // PAT mint failed – proceed with HOST/PROJECT_ID only.
  }

  await setRepoSecrets(ownerRepo, secrets);
}
