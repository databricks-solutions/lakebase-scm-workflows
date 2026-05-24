// GitHub repo CRUD via Octokit. Narrow surface ported from
// src/services/githubService.ts, only the methods create-project needs.
// All Octokit instances resolve their token through the unified seam
// (scripts/github/auth.ts, FEIP-7068).

import { Octokit, RequestError } from "octokit";
import { resolveGitHubToken } from "./auth.js";
import { parseOwnerRepo, formatOwnerRepo } from "../util/parse-owner-repo.js";

export class GitHubRepoError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubRepoError";
    this.status = status;
  }
}

interface OctokitContext {
  octokit: Octokit;
  /** Cached login of the authenticated user (avoids re-fetching for createRepo). */
  loginPromise?: Promise<string>;
}

async function newContext(): Promise<OctokitContext> {
  const token = await resolveGitHubToken();
  return { octokit: new Octokit({ auth: token }) };
}

function wrap(err: unknown, context: string): never {
  if (err instanceof RequestError) {
    throw new GitHubRepoError(`${context}: ${err.message}`, err.status);
  }
  if (err instanceof Error) {
    throw new GitHubRepoError(`${context}: ${err.message}`);
  }
  throw new GitHubRepoError(context);
}

async function getLogin(ctx: OctokitContext): Promise<string> {
  if (!ctx.loginPromise) {
    ctx.loginPromise = ctx.octokit.rest.users
      .getAuthenticated()
      .then(({ data }) => data.login);
  }
  return ctx.loginPromise;
}

/** Returns the GitHub login of the currently authenticated user. */
export async function getCurrentUser(): Promise<string> {
  try {
    const ctx = await newContext();
    return await getLogin(ctx);
  } catch (err) {
    wrap(err, "GitHub authentication failed");
  }
}

export interface CreateRepoOptions {
  /** Make the repo private. Default: true. */
  private?: boolean;
  description?: string;
}

/**
 * Create a new GitHub repository. Accepts either bare name (creates for the
 * authenticated user) or "owner/name" (creates in org if owner != login).
 *
 * @returns the repo HTML URL.
 */
export async function createRepo(name: string, opts: CreateRepoOptions = {}): Promise<string> {
  try {
    const ctx = await newContext();
    const isPrivate = opts.private !== false;
    const description = opts.description;

    if (name.includes("/")) {
      const { owner, repo } = parseOwnerRepo(name);
      const login = await getLogin(ctx);
      let data;
      if (owner.toLowerCase() === login.toLowerCase()) {
        ({ data } = await ctx.octokit.rest.repos.createForAuthenticatedUser({
          name: repo,
          private: isPrivate,
          description,
        }));
      } else {
        ({ data } = await ctx.octokit.rest.repos.createInOrg({
          org: owner,
          name: repo,
          private: isPrivate,
          description,
        }));
      }
      return data.html_url || `https://github.com/${formatOwnerRepo(owner, repo)}`;
    }

    const { data } = await ctx.octokit.rest.repos.createForAuthenticatedUser({
      name,
      private: isPrivate,
      description,
    });
    return data.html_url || `https://github.com/${data.full_name}`;
  } catch (err) {
    wrap(err, `Failed to create repository "${name}"`);
  }
}

/** Delete a GitHub repository. Requires the `delete_repo` OAuth scope. */
export async function deleteRepo(name: string): Promise<void> {
  try {
    const { owner, repo } = parseOwnerRepo(name);
    const ctx = await newContext();
    await ctx.octokit.rest.repos.delete({ owner, repo });
  } catch (err) {
    wrap(err, `Failed to delete repository "${name}"`);
  }
}

/** True iff the repository exists and is visible to the authenticated user. */
export async function repoExists(name: string): Promise<boolean> {
  try {
    const { owner, repo } = parseOwnerRepo(name);
    const ctx = await newContext();
    await ctx.octokit.rest.repos.get({ owner, repo });
    return true;
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) return false;
    wrap(err, `Failed to check repository "${name}"`);
  }
}

/**
 * Resolve the canonical `owner/repo` slug. Used by create-project to poll
 * until a freshly-created repo is visible (SAML / propagation delays).
 */
export async function getRepoFullName(name: string): Promise<string> {
  try {
    const { owner, repo } = parseOwnerRepo(name);
    const ctx = await newContext();
    const { data } = await ctx.octokit.rest.repos.get({ owner, repo });
    return data.full_name || formatOwnerRepo(owner, repo);
  } catch (err) {
    wrap(err, `Repository "${name}" is not visible`);
  }
}
