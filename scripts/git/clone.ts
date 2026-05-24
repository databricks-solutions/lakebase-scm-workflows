// Wrapper for `git clone`. Same one-liner the extension's GitService uses,
// promoted to a focused module so create-project can call it without
// pulling in the 1046-line gitService.

import { exec } from "../util/exec.js";

/**
 * Clone a Git repository into `parentDir`. Git creates the target dir as a
 * subdir of `parentDir` named after the repo.
 *
 * For HTTPS URLs, git will use whatever credential helper is configured –
 * typically the macOS keychain or `osxkeychain`. For SSH URLs, the user's
 * ssh agent. No GitHub token plumbing happens here.
 *
 * @throws Error if the clone subprocess exits non-zero (auth failure, repo
 *   not found, network error, etc.).
 */
export async function cloneRepo(repoUrl: string, parentDir: string): Promise<void> {
  await exec(`git clone "${repoUrl}"`, { cwd: parentDir, timeout: 60_000 });
}
