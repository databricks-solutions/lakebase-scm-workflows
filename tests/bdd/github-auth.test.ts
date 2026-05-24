import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  resolveGitHubToken,
  tryVsCodeSession,
  tryGhAuthToken,
  diagnoseGitHubAuth,
  GITHUB_SCOPES,
} from "../../scripts/github/auth.js";

// Save/restore env so tests don't leak.
const originalEnvToken = process.env.GITHUB_TOKEN;
afterEach(() => {
  if (originalEnvToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalEnvToken;
  }
});

describe("scopes", () => {
  it("exports the three scopes the workflow ops need", () => {
    expect([...GITHUB_SCOPES]).toEqual(["repo", "workflow", "delete_repo"]);
  });
});

describe("resolveGitHubToken – GITHUB_TOKEN env path", () => {
  it("returns the env value when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_TESTTOKEN_envset";
    const token = await resolveGitHubToken();
    expect(token).toBe("ghp_TESTTOKEN_envset");
  });

  it("trims whitespace from GITHUB_TOKEN", async () => {
    process.env.GITHUB_TOKEN = "  ghp_TESTTOKEN_padded  ";
    const token = await resolveGitHubToken();
    expect(token).toBe("ghp_TESTTOKEN_padded");
  });

  it("treats empty GITHUB_TOKEN as unset (falls through)", async () => {
    process.env.GITHUB_TOKEN = "   ";
    // With env empty, vscode unresolvable in pure Node, and gh maybe missing,
    // this either falls to a real `gh auth token` or throws. We only assert
    // that env-empty did not short-circuit to returning empty.
    try {
      const token = await resolveGitHubToken();
      expect(token).not.toBe("");
      expect(token.trim()).not.toBe("");
    } catch (err) {
      expect((err as Error).message).toMatch(/No GitHub auth available/);
    }
  });
});

describe("tryVsCodeSession (pure-Node runtime)", () => {
  it("returns undefined when `vscode` is unresolvable (i.e. outside ext host)", async () => {
    // Vitest runs in pure Node – the dynamic `import('vscode')` throws and we
    // expect undefined, NOT a thrown error. This is the contract the agent
    // path relies on.
    delete process.env.GITHUB_TOKEN;
    const result = await tryVsCodeSession();
    expect(result).toBeUndefined();
  });

  it("never throws even when called with createIfNone:true outside ext host", async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(tryVsCodeSession({ createIfNone: true })).resolves.toBeUndefined();
  });
});

describe("tryGhAuthToken", () => {
  const ghAvailable = (() => {
    try {
      execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!ghAvailable)("returns a non-empty token when gh is authenticated", () => {
    const token = tryGhAuthToken();
    // gh may be installed but not authed – both outcomes are valid; assert
    // either undefined or a non-empty string.
    if (token !== undefined) {
      expect(token).not.toBe("");
      expect(token.length).toBeGreaterThan(10);
    }
  });

  it("returns undefined when gh is not installed (skipped if gh is available)", () => {
    if (ghAvailable) return; // can't simulate gh-missing when gh is on PATH
    expect(tryGhAuthToken()).toBeUndefined();
  });
});

describe("resolveGitHubToken – clear error when no source", () => {
  it("throws a descriptive error when env unset, gh unavailable, vscode unresolvable", async () => {
    delete process.env.GITHUB_TOKEN;
    const ghAvailable = (() => {
      try {
        const t = execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 })
          .toString()
          .trim();
        return t.length > 0;
      } catch {
        return false;
      }
    })();
    if (ghAvailable) {
      // We can't easily simulate gh-missing on a dev machine; skip the
      // negative assertion. The diagnostic test below still covers shape.
      return;
    }
    await expect(resolveGitHubToken()).rejects.toThrow(/No GitHub auth available/);
  });
});

describe("diagnoseGitHubAuth", () => {
  it("returns the documented shape and lists env first when set", async () => {
    process.env.GITHUB_TOKEN = "ghp_TESTTOKEN_diagnose";
    const d = await diagnoseGitHubAuth();
    expect(d.scopes).toEqual(["repo", "workflow", "delete_repo"]);
    expect(d.sources).toContain("env");
    expect(d.primary).toBe("env");
  });

  it("omits env from sources when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN;
    const d = await diagnoseGitHubAuth();
    expect(d.sources).not.toContain("env");
  });

  it("never leaks a token value via the diagnosis object", async () => {
    process.env.GITHUB_TOKEN = "ghp_SECRET_DO_NOT_LEAK";
    const d = await diagnoseGitHubAuth();
    expect(JSON.stringify(d)).not.toContain("ghp_SECRET_DO_NOT_LEAK");
  });
});
