// .env emission for a freshly-scaffolded Lakebase-paired project + per-branch
// connection updates.
//
// `writeEnvFile` mirrors ProjectCreationService.writeEnvFile — initial scaffold
// with commented placeholders. `updateEnvConnection` mirrors the algorithm in
// templates/.../post-checkout.sh: strip the four connection lines, append
// fresh ones, preserve everything else.

import * as fs from "node:fs";
import * as path from "node:path";

export interface WriteEnvFileArgs {
  projectDir: string;
  databricksHost: string;
  lakebaseProjectId: string;
}

/**
 * Write a .env to {projectDir}/.env with the two fixed config keys and
 * commented connection placeholders. Overwrites any existing .env.
 *
 * @returns the absolute path of the written file.
 */
export function writeEnvFile(args: WriteEnvFileArgs): string {
  const host = args.databricksHost.replace(/\/+$/, "");
  const envContent = [
    "# Lakebase project configuration",
    "# Created by @databricks-solutions/lakebase-scm-workflow-scripts",
    "",
    `DATABRICKS_HOST=${host}`,
    `LAKEBASE_PROJECT_ID=${args.lakebaseProjectId}`,
    "",
    "# Connection (auto-populated on branch switch)",
    "# DATABASE_URL=",
    "# DB_USERNAME=",
    "# DB_PASSWORD=",
    "",
  ].join("\n");
  const envPath = path.join(args.projectDir, ".env");
  fs.writeFileSync(envPath, envContent);
  return envPath;
}

export interface UpdateEnvConnectionArgs {
  /** Absolute path to the .env file. */
  envPath: string;
  /** Lakebase branch id this .env now points at (sanitized name). */
  branchId: string;
  /** Full postgresql:// DSN, or "" when connection is pending. */
  databaseUrl: string;
  /** Lakebase user (email). */
  username: string;
  /** Short-lived OAuth token. */
  password: string;
  /** Optional comment line prepended to the connection block. */
  comment?: string;
}

const CONNECTION_KEYS = ["DATABASE_URL", "DB_USERNAME", "DB_PASSWORD", "LAKEBASE_BRANCH_ID"] as const;

/**
 * Update the connection block (LAKEBASE_BRANCH_ID, DATABASE_URL, DB_USERNAME,
 * DB_PASSWORD) in an existing .env file, preserving every other line.
 *
 * Algorithm matches templates/project/common/scripts/post-checkout.sh:
 *   1. Read existing .env
 *   2. Drop any line starting with one of the four connection keys
 *   3. Append the fresh block (with optional leading comment)
 *
 * If the file doesn't exist, it's created with just the connection block —
 * caller can subsequently writeEnvFile() to add the project-level keys.
 */
export function updateEnvConnection(args: UpdateEnvConnectionArgs): void {
  const existing = fs.existsSync(args.envPath)
    ? fs.readFileSync(args.envPath, "utf-8")
    : "";

  const preserved = existing
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !CONNECTION_KEYS.some((k) => trimmed.startsWith(`${k}=`));
    })
    .join("\n")
    .replace(/\n+$/, "");

  const block = [
    args.comment ?? "",
    `LAKEBASE_BRANCH_ID=${args.branchId}`,
    `DATABASE_URL=${args.databaseUrl}`,
    `DB_USERNAME=${args.username}`,
    `DB_PASSWORD=${args.password}`,
    "",
  ]
    .filter((line) => line !== "" || args.comment !== undefined)
    .join("\n");

  const content = preserved ? `${preserved}\n${block}` : block;
  // Ensure parent dir exists for the no-existing-file case
  fs.mkdirSync(path.dirname(args.envPath), { recursive: true });
  fs.writeFileSync(args.envPath, content);
}
