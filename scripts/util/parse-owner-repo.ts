// Parse `owner/repo` from a slug, HTTPS URL, or git SSH URL.
// Ported from src/utils/parseRepo.ts in the extension; same shape so the
// extension's call sites can swap to this import once published (FEIP-7065).

export interface OwnerRepo {
  owner: string;
  repo: string;
}

export function parseOwnerRepo(urlOrSlug: string): OwnerRepo {
  const trimmed = urlOrSlug.trim().replace(/\.git$/, "");
  if (trimmed.includes("/")) {
    // Match github.com URLs explicitly so we don't mis-parse paths like
    // `subdir/owner/repo` from an SSH-style URL.
    const slugMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)/);
    if (slugMatch) {
      return { owner: slugMatch[1], repo: slugMatch[2] };
    }
    const parts = trimmed.split("/");
    if (parts.length >= 2) {
      return {
        owner: parts[parts.length - 2],
        repo: parts[parts.length - 1],
      };
    }
  }
  throw new Error(`Invalid GitHub repo reference: ${urlOrSlug}`);
}

export function formatOwnerRepo(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
