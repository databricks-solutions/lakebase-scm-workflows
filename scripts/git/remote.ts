// Resolve the origin remote's GitHub URL / owner-repo slug.
// Ported from gitService.getGitHubUrl + getOwnerRepo.

import { exec } from "../util/exec.js";
import { parseOwnerRepo, formatOwnerRepo } from "../util/parse-owner-repo.js";

/**
 * Read `git remote get-url origin` and normalize to https://github.com/owner/repo.
 * Returns empty string if not a git repo or origin isn't GitHub.
 */
export async function getGitHubUrl(cwd: string): Promise<string> {
  try {
    const url = (await exec("git remote get-url origin", { cwd, timeout: 5_000 })).trim();
    return url
      .replace(/\.git$/, "")
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  } catch {
    return "";
  }
}

/** owner/repo slug for the origin remote; empty string if not GitHub. */
export async function getOwnerRepo(cwd: string): Promise<string> {
  const url = await getGitHubUrl(cwd);
  if (!url) return "";
  try {
    const { owner, repo } = parseOwnerRepo(url);
    return formatOwnerRepo(owner, repo);
  } catch {
    return "";
  }
}
