// Normalize a git branch name into a Lakebase-compatible branch id.
// Ported verbatim from src/services/lakebaseService.ts:sanitizeBranchName.
//
// Lakebase rules: lowercase, alphanumeric + hyphens only, max 63 chars,
// min 3 chars (padded with "-x" if shorter).

export function sanitizeBranchName(gitBranch: string): string {
  let name = gitBranch
    .replace(/\//g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .substring(0, 63);
  while (name.length < 3) name += "-x";
  return name;
}
