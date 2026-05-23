// `git init -b main` inside an already-created directory. Mirrors the
// no-GitHub branch of ProjectCreationService.

import { exec } from "../util/exec.js";

/**
 * Initialize a git repo in `projectDir` with the default branch set to
 * "main". Caller is responsible for ensuring `projectDir` exists.
 */
export async function gitInit(projectDir: string): Promise<void> {
  await exec("git init -b main", { cwd: projectDir, timeout: 15_000 });
}
