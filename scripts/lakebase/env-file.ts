// .env emission for a freshly-scaffolded Lakebase-paired project.
//
// Mirrors ProjectCreationService.writeEnvFile from the extension. Connection
// values are intentionally left commented — they're populated per-branch by
// branch-checkout (FEIP-7063) once the branch's endpoint is ready.

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
