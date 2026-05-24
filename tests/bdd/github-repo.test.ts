import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { getCurrentUser, getRepoFullName } from "../../scripts/github/repo.js";
import { resolveGitHubToken } from "../../scripts/github/auth.js";

// Live skip-when-no-auth: only fires when a real GitHub token can be
// resolved. createRepo/deleteRepo are destructive and need a target test
// org, those live in the equivalence test (FEIP-7071), not here. This
// suite only asserts that the read paths work end-to-end.

const tokenAvailable = (() => {
  if (process.env.GITHUB_TOKEN?.trim()) return true;
  try {
    const t = execFileSync("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).toString().trim();
    return t.length > 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!tokenAvailable)("github/repo, live read paths", () => {
  it("getCurrentUser returns a non-empty GitHub login", async () => {
    const login = await getCurrentUser();
    expect(login).toBeTruthy();
    expect(login).not.toContain("/");
    expect(login.length).toBeGreaterThan(0);
  });

  it("getRepoFullName resolves the canonical slug for a known public repo", async () => {
    // octokit/octokit.js is the package we depend on, definitely public,
    // definitely stable, definitely reachable from any GitHub-authed env.
    const full = await getRepoFullName("octokit/octokit.js");
    expect(full.toLowerCase()).toBe("octokit/octokit.js");
  });
});

describe("github/repo, skip-when-no-auth", () => {
  it("documents the skip reason when no token is available", () => {
    if (tokenAvailable) return;
    // eslint-disable-next-line no-console
    console.log(
      "GITHUB_TOKEN / `gh auth token` not available, live github/repo suite skipped."
    );
    expect(tokenAvailable).toBe(false);
  });
});

describe("github/repo, token resolution wiring", () => {
  it("resolveGitHubToken either returns a token or throws the documented error", async () => {
    try {
      const t = await resolveGitHubToken();
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    } catch (err) {
      expect((err as Error).message).toMatch(/No GitHub auth available/);
    }
  });
});
