import { describe, it, expect } from "vitest";
import { GitHubSecretsError, setRepoSecrets } from "../../scripts/github/secrets.js";

// setRepoSecret/setRepoSecrets are destructive (writes encrypted secrets
// to a real repo's Actions). Live tests require a dedicated test repo;
// the BDD equivalence harness exercises them with proper teardown.
// This suite covers error wrapping + the empty-value guard.

describe("GitHubSecretsError", () => {
  it("carries name + optional status", () => {
    const err = new GitHubSecretsError("oops", 403);
    expect(err.name).toBe("GitHubSecretsError");
    expect(err.message).toBe("oops");
    expect(err.status).toBe(403);
  });
});

describe("setRepoSecrets – empty-value guard", () => {
  it("rejects empty secret values before making any API call", async () => {
    await expect(
      setRepoSecrets("foo/bar", { GOOD: "value", EMPTY: "" })
    ).rejects.toThrow(/Missing value for secret EMPTY/);
  });
});
