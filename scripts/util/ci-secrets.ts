// Sync CI secrets (DATABRICKS_HOST, LAKEBASE_PROJECT_ID, DATABRICKS_TOKEN)
// to the GitHub repo. Mints a fresh Databricks PAT when possible; falls
// back to .env's DATABRICKS_TOKEN.
//
// Ported from src/utils/ciSecrets.ts. The agent-callable form takes the
// projectDir + repo name as explicit args (no workspace-root assumption).

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "./exec.js";
import { setRepoSecrets } from "../github/secrets.js";
import { getOwnerRepo } from "../git/remote.js";

export interface SyncCiSecretsArgs {
  /** Project root containing .env. */
  projectDir: string;
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

  const envPath = path.join(args.projectDir, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }
  const envContent = fs.readFileSync(envPath, "utf-8");
  const getEnvVal = (key: string): string => {
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match ? match[1].trim() : "";
  };

  const host = getEnvVal("DATABRICKS_HOST");
  const projectId = getEnvVal("LAKEBASE_PROJECT_ID");
  const secrets: Record<string, string> = {};
  if (host) secrets.DATABRICKS_HOST = host;
  if (projectId) secrets.LAKEBASE_PROJECT_ID = projectId;

  // Mint a fresh PAT; fall back to .env token if available.
  try {
    const tokenRaw = await exec(
      `databricks tokens create --comment "${comment}" --lifetime-seconds ${lifetime} -o json`,
      { cwd: args.projectDir, timeout: 30_000, env: { DATABRICKS_HOST: host } }
    );
    const parsed = JSON.parse(tokenRaw);
    const token = parsed.token_value || parsed.token || "";
    if (token) secrets.DATABRICKS_TOKEN = token;
  } catch {
    const existing = getEnvVal("DATABRICKS_TOKEN");
    if (existing) secrets.DATABRICKS_TOKEN = existing;
  }

  if (Object.keys(secrets).length > 0) {
    await setRepoSecrets(ownerRepo, secrets);
  }
}
