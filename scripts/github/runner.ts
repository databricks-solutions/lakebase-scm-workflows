// Self-hosted runner Octokit calls. Narrow surface – only the methods
// scripts/lakebase/runner-setup.ts needs. Routes auth through
// resolveGitHubToken (FEIP-7068).

import { Octokit, RequestError } from "octokit";
import { resolveGitHubToken } from "./auth.js";
import { parseOwnerRepo } from "../util/parse-owner-repo.js";

export class GitHubRunnerError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubRunnerError";
    this.status = status;
  }
}

async function getOctokit(): Promise<Octokit> {
  const token = await resolveGitHubToken();
  return new Octokit({ auth: token });
}

function wrap(err: unknown, context: string): never {
  if (err instanceof RequestError) {
    throw new GitHubRunnerError(`${context}: ${err.message}`, err.status);
  }
  if (err instanceof Error) {
    throw new GitHubRunnerError(`${context}: ${err.message}`);
  }
  throw new GitHubRunnerError(context);
}

export interface RepoRunner {
  id: number;
  name: string;
  status: string;
}

/**
 * Create a short-lived registration token for `config.sh`. Surfaces a
 * clear error when the signed-in user cannot see the repo (404 / SAML).
 */
export async function createRegistrationToken(ownerRepo: string): Promise<string> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const octokit = await getOctokit();
    const { data } = await octokit.rest.actions.createRegistrationTokenForRepo({ owner, repo });
    if (!data.token) {
      throw new GitHubRunnerError("Registration token missing from GitHub response");
    }
    return data.token;
  } catch (err) {
    if (err instanceof GitHubRunnerError) throw err;
    if (err instanceof RequestError && err.status === 404) {
      throw new GitHubRunnerError(
        `GitHub returned 404 for "${ownerRepo}". The signed-in user can't see this repo – ` +
          `it's likely private and owned by a different account. Sign in to GitHub as the repo ` +
          `owner (or set GITHUB_TOKEN to a token with access) and retry.`,
        404
      );
    }
    wrap(err, "Failed to create runner registration token");
  }
}

/** List all self-hosted runners registered on the repo. */
export async function listRepoRunners(ownerRepo: string): Promise<RepoRunner[]> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const octokit = await getOctokit();
    const { data } = await octokit.rest.actions.listSelfHostedRunnersForRepo({ owner, repo });
    return (data.runners ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
    }));
  } catch (err) {
    wrap(err, `Failed to list runners for "${ownerRepo}"`);
  }
}

/** Find a runner by name on the repo; returns undefined if not present. */
export async function getRunnerIdByName(
  ownerRepo: string,
  runnerName: string
): Promise<number | undefined> {
  const runners = await listRepoRunners(ownerRepo);
  return runners.find((r) => r.name === runnerName)?.id;
}

/** Get the GitHub-reported status of a runner by name. */
export async function getRunnerStatus(
  ownerRepo: string,
  runnerName: string
): Promise<string | undefined> {
  const runners = await listRepoRunners(ownerRepo);
  return runners.find((r) => r.name === runnerName)?.status;
}

/** Deregister a runner from the repo (best-effort – failures are swallowed). */
export async function deleteRunner(ownerRepo: string, runnerId: number): Promise<void> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const octokit = await getOctokit();
    await octokit.rest.actions.deleteSelfHostedRunnerFromRepo({ owner, repo, runner_id: runnerId });
  } catch {
    /* best-effort */
  }
}
