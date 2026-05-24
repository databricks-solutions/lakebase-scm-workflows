# `github-auth`, unified GitHub token resolver

Single GitHub auth seam for Lakebase SCM workflows. Both the VS Code extension and the agent call this module from the same .js function, same behavior, different runtime contexts.

Every other workflow op that touches GitHub resolves a token through this module. A CI grep guard (`.github/workflows/github-auth-grep-guard.yml`) fails the build if anything else constructs an Octokit with a directly-resolved token.

## Fallback chain

`resolveGitHubToken()` tries these sources in order:

1. **`GITHUB_TOKEN` env var**: set this for CI, headless automation, integration tests.
2. **VS Code `authentication.getSession('github', …)`**: dynamic `import('vscode')` resolves only inside the extension host. In pure Node it throws and we silently fall through.
3. **`gh auth token`**: shells out to the GitHub CLI. Catches users who already authenticated via `gh auth login`.
4. **Clear error**: `"No GitHub auth available. Set GITHUB_TOKEN, sign in to GitHub in VS Code, or run `gh auth login`."`

The chain is non-interactive. For the sign-in UX (`createIfNone: true`), the extension's `ensureGitHubAuth()` wrapper calls `tryVsCodeSession({ createIfNone: true })` directly.

## Scopes

```
['repo', 'workflow', 'delete_repo']
```

`workflow` is required because the extension writes `.github/workflows/*` during scaffold and any commit that touches those paths is rejected without it. `delete_repo` is required for the cleanup path on partial-creation failures.

## CLI

```bash
lakebase-github-token                 # prints the token on stdout
lakebase-github-token --json          # { "token": "...", "source": "env" | "vscode" | "gh" }
lakebase-github-token --diagnose      # which sources are available (no token leak)
```

Examples:

```bash
# Pipe into Octokit / curl:
GH=$(lakebase-github-token)
curl -H "Authorization: bearer $GH" https://api.github.com/user

# Safe-to-log diagnostic:
lakebase-github-token --diagnose
# Available sources: env, gh
# Primary: env
# Scopes: repo, workflow, delete_repo
```

## Module

```ts
import { resolveGitHubToken, tryVsCodeSession, tryGhAuthToken, diagnoseGitHubAuth }
  from "@databricks-solutions/lakebase-app-dev-kit";
import { Octokit } from "octokit";

const token = await resolveGitHubToken();
const octokit = new Octokit({ auth: token });
const { data } = await octokit.rest.users.getAuthenticated();
```

## Extension integration

The extension's `src/utils/githubAuth.ts` becomes a thin wrapper that adds the *interactive* path on top of the shared resolver:

```ts
// src/utils/githubAuth.ts (post-FEIP-7068, post-FEIP-7065)
import { resolveGitHubToken, tryVsCodeSession }
  from "@databricks-solutions/lakebase-app-dev-kit";

export const GITHUB_SCOPES = ["repo", "workflow", "delete_repo"] as const;

/** Non-interactive, delegates to the shared resolver. */
export const getGitHubToken = resolveGitHubToken;

/** Interactive, prompts VS Code sign-in. Extension-only. */
export async function ensureGitHubAuth(): Promise<string> {
  const token =
    (await tryVsCodeSession({ createIfNone: true })) ??
    (await resolveGitHubToken());
  // Validate via Octokit; returns the authenticated login.
  ...
}
```

Pre-FEIP-7065, the extension keeps its own resolver and consumes this helper once the npm package is installable.

## Why one helper

GitHub credentials come from at least three places in our setup (env var, VS Code session, gh CLI). Letting each call site pick its own source produces drift, different paths handle missing creds with different error messages, and a bug in one path is invisible from the others. One seam, one fallback chain, one grep guard. Same shape as the Lakebase credential helper (`get-connection.ts`, FEIP-7061).
