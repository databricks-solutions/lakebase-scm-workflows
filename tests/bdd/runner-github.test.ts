import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  listRepoRunners,
  getRunnerIdByName,
  getRunnerStatus,
  GitHubRunnerError,
} from "../../scripts/github/runner.js";

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

describe.skipIf(!tokenAvailable)("github/runner — live read paths", () => {
  // octokit/octokit.js is public, doesn't expose self-hosted runners to
  // arbitrary readers; the API typically returns 403 or empty depending
  // on token permissions. Either is a valid wrap-error path to test.
  it("listRepoRunners either returns an array or throws GitHubRunnerError (no crash)", async () => {
    try {
      const runners = await listRepoRunners("octokit/octokit.js");
      expect(Array.isArray(runners)).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRunnerError);
    }
  });

  it("getRunnerIdByName returns undefined for a name that doesn't exist", async () => {
    try {
      const id = await getRunnerIdByName("octokit/octokit.js", "definitely-not-a-runner-zzz123");
      expect(id).toBeUndefined();
    } catch (err) {
      // 403/404 from unauth'd access is acceptable
      expect(err).toBeInstanceOf(GitHubRunnerError);
    }
  });

  it("getRunnerStatus returns undefined for a name that doesn't exist", async () => {
    try {
      const status = await getRunnerStatus("octokit/octokit.js", "definitely-not-a-runner-zzz123");
      expect(status).toBeUndefined();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRunnerError);
    }
  });
});

describe("github/runner — error wrapping", () => {
  it("GitHubRunnerError carries name + optional status", () => {
    const err = new GitHubRunnerError("oops", 404);
    expect(err.name).toBe("GitHubRunnerError");
    expect(err.message).toBe("oops");
    expect(err.status).toBe(404);
  });
});

describe("github/runner — skip-when-no-auth", () => {
  it("documents the skip reason when no token is available", () => {
    if (tokenAvailable) return;
    // eslint-disable-next-line no-console
    console.log("GITHUB_TOKEN / `gh auth token` not available — live runner read suite skipped.");
    expect(tokenAvailable).toBe(false);
  });
});
