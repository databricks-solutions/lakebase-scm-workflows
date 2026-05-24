// Single GitHub auth seam for Lakebase SCM workflows.
//
// Both the VS Code extension and the agent call this module. Same module,
// same behavior, different runtime contexts.
//
//   1. VS Code session  (dynamic `import('vscode')` – resolves only inside
//                        the extension host; throws+catches in pure Node)
//   2. GITHUB_TOKEN env var
//   3. `gh auth token`  (catches users with the gh CLI authenticated)
//   4. Clear error
//
// No other file in this codebase should resolve a GitHub token directly.
// `.github/workflows/github-auth-grep-guard.yml` fails the build if any
// other file does so.

import { execFileSync } from "node:child_process";

/** OAuth scopes the workflow ops collectively need. */
export const GITHUB_SCOPES = ["repo", "workflow", "delete_repo"] as const;

/**
 * Resolve a GitHub token through the unified fallback chain.
 *
 * Non-interactive – never prompts. For the interactive sign-in UX
 * (`createIfNone: true`), the extension's `ensureGitHubAuth()` wrapper
 * calls `tryVsCodeSession({ createIfNone: true })` directly.
 *
 * @param scopes optional override of GITHUB_SCOPES (rare – most callers use the default)
 */
export async function resolveGitHubToken(
  scopes: readonly string[] = GITHUB_SCOPES
): Promise<string> {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const fromVsCode = await tryVsCodeSession({ scopes });
  if (fromVsCode) return fromVsCode;

  const fromGh = tryGhAuthToken();
  if (fromGh) return fromGh;

  throw new Error(
    "No GitHub auth available. Set GITHUB_TOKEN, sign in to GitHub in VS Code, or run `gh auth login`."
  );
}

export interface VsCodeSessionOptions {
  /** Defaults to GITHUB_SCOPES. */
  scopes?: readonly string[];
  /**
   * When true and no session exists, VS Code prompts the user to sign in.
   * Only meaningful inside the extension host; ignored elsewhere.
   * Default: false (silent).
   */
  createIfNone?: boolean;
}

/**
 * Resolve a token from the VS Code GitHub session, or undefined when:
 *   - We're not inside the extension host (`vscode` module unresolvable)
 *   - No session exists and `createIfNone` is false
 *   - Any error in the session call
 */
export async function tryVsCodeSession(
  opts: VsCodeSessionOptions = {}
): Promise<string | undefined> {
  const scopes = opts.scopes ?? GITHUB_SCOPES;
  try {
    // Dynamic import so this module loads cleanly in pure-Node (agent path).
    // Inside the extension host, VS Code injects the `vscode` module and the
    // import resolves to the real API. Outside (tests, CI, agent runtime),
    // the import throws MODULE_NOT_FOUND and we silently fall through.
    const vscode = (await import("vscode" as string)) as VsCodeApiShape;
    if (!vscode?.authentication?.getSession) return undefined;
    const session = await vscode.authentication.getSession("github", [...scopes], {
      createIfNone: !!opts.createIfNone,
    });
    return session?.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a token by shelling out to `gh auth token`. Returns undefined if
 * gh isn't installed, isn't authenticated, or any other failure.
 */
export function tryGhAuthToken(): string | undefined {
  try {
    const raw = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const token = raw.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Diagnostic helper. Reports which sources are configured / would
 * succeed, without revealing the token itself. Used by the CLI's
 * `--diagnose` flag and by tests.
 */
export async function diagnoseGitHubAuth(): Promise<GitHubAuthDiagnosis> {
  const envSet = !!process.env.GITHUB_TOKEN?.trim();
  const vscodeAvailable = await tryVsCodeSession().then(Boolean).catch(() => false);
  const ghAvailable = !!tryGhAuthToken();
  const sources: GitHubAuthSource[] = [];
  if (envSet) sources.push("env");
  if (vscodeAvailable) sources.push("vscode");
  if (ghAvailable) sources.push("gh");
  return {
    sources,
    primary: sources[0],
    scopes: [...GITHUB_SCOPES],
  };
}

export type GitHubAuthSource = "env" | "vscode" | "gh";

export interface GitHubAuthDiagnosis {
  /** Sources that returned a usable token, in fallback order. */
  sources: GitHubAuthSource[];
  /** First source `resolveGitHubToken` would use, or undefined if none. */
  primary?: GitHubAuthSource;
  scopes: string[];
}

// Minimal shape of the bits of the `vscode` module we touch. Defined locally
// so this file has no compile-time dependency on `@types/vscode` (the agent
// path wouldn't have it installed).
interface VsCodeApiShape {
  authentication?: {
    getSession?: (
      provider: string,
      scopes: string[],
      options: { createIfNone: boolean }
    ) => Promise<{ accessToken?: string } | undefined>;
  };
}
