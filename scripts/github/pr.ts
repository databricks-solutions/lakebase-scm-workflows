// GitHub Pull Request operations.
//
// Wraps Octokit calls for the PR flow that the Lakebase SCM workflow needs:
// create/get/merge PRs, read reviews and files and comments, list workflow
// runs. Auth resolves through the canonical seam (scripts/github/auth.ts).
//
// The pairing-aware operation `mergePairedPullRequest` lives at the bottom.
// it merges the GitHub PR and cleans up the matching feature Lakebase branch
// best-effort.

import { Octokit, RequestError } from "octokit";
import { resolveGitHubToken } from "./auth.js";
import { parseOwnerRepo } from "../util/parse-owner-repo.js";
import { deleteBranch } from "../lakebase/branch-delete.js";
import { sanitizeBranchName } from "../util/sanitize-branch-name.js";

export class GitHubPullRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GitHubPullRequestError";
  }
}

async function octokit(): Promise<Octokit> {
  const token = await resolveGitHubToken();
  return new Octokit({ auth: token });
}

function wrap(err: unknown, context: string): never {
  if (err instanceof RequestError) {
    throw new GitHubPullRequestError(`${context}: ${err.message}`, err.status);
  }
  if (err instanceof Error) {
    throw new GitHubPullRequestError(`${context}: ${err.message}`);
  }
  throw new GitHubPullRequestError(context);
}

// ─── Types ──────────────────────────────────────────────────────

export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string;
  detailsUrl?: string;
}

export interface PullRequestReview {
  author: string;
  state: string;
  body: string;
  submittedAt?: string;
}

export interface PullRequestFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  ciStatus: "pending" | "success" | "failure";
  checks: PullRequestCheck[];
  headBranch: string;
  baseBranch: string;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  branch: string;
  event: string;
  /** ISO 8601 timestamp from GitHub. Useful for filtering out runs older than
   * a session start time or detecting stuck/orphaned runs whose updated_at
   * lags. May be `undefined` if the API omitted it. */
  createdAt?: string;
  updatedAt?: string;
}

// ─── Primitive PR ops ──────────────────────────────────────────

export interface CreatePullRequestArgs {
  ownerRepo: string;
  headBranch: string;
  title: string;
  body: string;
  /** Target branch. Omit to use the repo's default branch. */
  baseBranch?: string;
}

/** Create a pull request. Returns the HTML URL. */
export async function createPullRequest(args: CreatePullRequestArgs): Promise<string> {
  try {
    const { owner, repo } = parseOwnerRepo(args.ownerRepo);
    const ok = await octokit();
    let base = args.baseBranch;
    if (!base) {
      const { data: repoData } = await ok.rest.repos.get({ owner, repo });
      base = repoData.default_branch || "main";
    }
    const { data } = await ok.rest.pulls.create({
      owner,
      repo,
      title: args.title,
      head: args.headBranch,
      base,
      body: args.body,
    });
    return data.html_url || "";
  } catch (err) {
    wrap(err, "Failed to create pull request");
  }
}

/** Find the open PR whose head branch matches; returns the full PR info + CI status. */
export async function getPullRequest(
  ownerRepo: string,
  headBranch: string
): Promise<PullRequestInfo | undefined> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ok = await octokit();
    const { data: pulls } = await ok.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${headBranch}`,
      per_page: 1,
    });
    if (pulls.length === 0) return undefined;
    const { data: pr } = await ok.rest.pulls.get({
      owner,
      repo,
      pull_number: pulls[0].number,
    });
    if (pr.state !== "open") return undefined;

    let checks: PullRequestCheck[] = [];
    let ciStatus: PullRequestInfo["ciStatus"] = "pending";
    const headSha = pr.head?.sha;
    if (headSha) {
      try {
        const { data: checksData } = await ok.rest.checks.listForRef({
          owner,
          repo,
          ref: headSha,
        });
        const runs = checksData.check_runs || [];
        checks = runs.map((c) => ({
          name: c.name || "unknown",
          status: (c.status || "").toUpperCase(),
          conclusion: (c.conclusion || "").toUpperCase(),
          detailsUrl: c.details_url || undefined,
        }));
        ciStatus = parseCiStatus(runs);
      } catch {
        ciStatus = "pending";
      }
    }

    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url || "",
      state: (pr.state || "open").toUpperCase(),
      isDraft: pr.draft || false,
      ciStatus,
      checks,
      headBranch: pr.head?.ref || headBranch,
      baseBranch: pr.base?.ref || "",
      body: pr.body || undefined,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
    };
  } catch {
    return undefined;
  }
}

function parseCiStatus(
  rawChecks: Array<{ name?: string | null; status?: string | null; conclusion?: string | null }>
): PullRequestInfo["ciStatus"] {
  if (rawChecks.length === 0) return "pending";
  const latestByName = new Map<string, { conclusion?: string | null; status?: string | null }>();
  for (const c of rawChecks) {
    latestByName.set(c.name || "unknown", c);
  }
  const states = Array.from(latestByName.values()).map((c) =>
    (c.conclusion || c.status || "").toUpperCase()
  );
  if (states.some((s) => s === "FAILURE" || s === "ERROR" || s === "ACTION_REQUIRED")) {
    return "failure";
  }
  if (states.every((s) => s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED")) {
    return "success";
  }
  return "pending";
}

/** Reviews on a PR (approvals, change requests, comments). */
export async function getPullRequestReviews(
  ownerRepo: string,
  pullNumber: number
): Promise<PullRequestReview[]> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ok = await octokit();
    const { data } = await ok.rest.pulls.listReviews({ owner, repo, pull_number: pullNumber });
    return data.map((r) => ({
      author: r.user?.login || "unknown",
      state: r.state || "COMMENTED",
      body: r.body || "",
      submittedAt: r.submitted_at || undefined,
    }));
  } catch {
    return [];
  }
}

/** Files changed in a PR. */
export async function getPullRequestFiles(
  ownerRepo: string,
  pullNumber: number
): Promise<PullRequestFile[]> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ok = await octokit();
    const { data } = await ok.rest.pulls.listFiles({ owner, repo, pull_number: pullNumber });
    const statusMap: Record<string, PullRequestFile["status"]> = {
      added: "added",
      removed: "deleted",
      modified: "modified",
      renamed: "renamed",
    };
    return data.map((f) => ({
      path: f.filename || "",
      status: statusMap[(f.status || "").toLowerCase()] || "modified",
      additions: f.additions || 0,
      deletions: f.deletions || 0,
    }));
  } catch {
    return [];
  }
}

/** Issue/PR comments (e.g. schema-diff CI bot comments). */
export async function getPullRequestComments(
  ownerRepo: string,
  pullNumber: number
): Promise<Array<{ author: string; body: string }>> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ok = await octokit();
    const { data } = await ok.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
    });
    return data.map((c) => ({
      author: c.user?.login || "unknown",
      body: c.body || "",
    }));
  } catch {
    return [];
  }
}

/** Plain list of issue/PR comment bodies (filtered for non-empty). */
export async function listIssueComments(ownerRepo: string, issueNumber: number): Promise<string[]> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ok = await octokit();
    const { data } = await ok.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data.map((c) => c.body || "").filter(Boolean);
  } catch {
    return [];
  }
}

export interface MergePullRequestArgs {
  ownerRepo: string;
  pullNumber: number;
  /** Default: "merge". */
  method?: "merge" | "squash" | "rebase";
  /** Default: true. Delete the remote head branch after merge. */
  deleteRemoteBranch?: boolean;
}

/** Merge a PR. Optionally deletes the remote head branch. */
export async function mergePullRequest(args: MergePullRequestArgs): Promise<string> {
  const method = args.method ?? "merge";
  const deleteRemoteBranch = args.deleteRemoteBranch !== false;
  try {
    const { owner, repo } = parseOwnerRepo(args.ownerRepo);
    const ok = await octokit();
    const { data } = await ok.rest.pulls.merge({
      owner,
      repo,
      pull_number: args.pullNumber,
      merge_method: method,
    });
    if (deleteRemoteBranch) {
      try {
        const pr = await ok.rest.pulls.get({ owner, repo, pull_number: args.pullNumber });
        const headRef = pr.data.head.ref;
        await ok.rest.git.deleteRef({
          owner,
          repo,
          ref: `heads/${headRef}`,
        });
      } catch {
        /* branch may already be gone */
      }
    }
    return data.message || `Merged PR #${args.pullNumber}`;
  } catch (err) {
    wrap(err, "Failed to merge pull request");
  }
}

/** Recent workflow runs for a repo. */
export async function listWorkflowRuns(
  ownerRepo: string,
  limit = 5
): Promise<WorkflowRunSummary[]> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ok = await octokit();
    const { data } = await ok.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: limit,
    });
    return (data.workflow_runs || []).map((r) => ({
      id: r.id,
      name: r.name || "",
      status: r.status || "",
      conclusion: r.conclusion || "",
      branch: r.head_branch || "",
      event: r.event || "",
      createdAt: r.created_at || undefined,
      updatedAt: r.updated_at || undefined,
    }));
  } catch {
    return [];
  }
}

// ─── Paired op: PR merge + Lakebase feature branch cleanup ─────

export interface MergePairedPullRequestArgs {
  ownerRepo: string;
  pullNumber: number;
  /** Lakebase project id used to clean up the feature branch on merge. */
  lakebaseInstance: string;
  /** Default: "merge". */
  method?: "merge" | "squash" | "rebase";
  /** Delete the remote head git branch. Default: true. */
  deleteRemoteBranch?: boolean;
  /** Delete the matching feature Lakebase branch after merge. Default: true. */
  deleteLakebaseBranch?: boolean;
}

export interface MergePairedPullRequestResult {
  /** GitHub merge confirmation message. */
  message: string;
  /** The PR's head branch name (used to resolve the Lakebase feature branch). */
  headBranch: string;
  /** True iff the matching feature Lakebase branch was deleted. */
  lakebaseBranchDeleted: boolean;
  warnings: string[];
}

/**
 * Merge a GitHub PR and clean up the matching feature Lakebase branch.
 *
 * The pairing-aware merge operation: once the code change lands in the base
 * git branch, the feature Lakebase branch has served its purpose (CI replays
 * its migrations against the base Lakebase branch automatically). Best-effort
 * delete keeps Lakebase branch counts from growing unbounded.
 *
 * Note: this does NOT auto-apply schema migrations against the base Lakebase
 * branch. That happens via the CI workflow on the base branch's next push.
 * The "parent-matched merge" is structurally: head git → base git, then
 * delete the feature Lakebase (its schema is already in the base via merged
 * migrations).
 */
export async function mergePairedPullRequest(
  args: MergePairedPullRequestArgs
): Promise<MergePairedPullRequestResult> {
  const warnings: string[] = [];
  const deleteLakebaseBranch = args.deleteLakebaseBranch !== false;

  // 1. Look up the PR to capture head branch before we merge (and potentially
  //    delete the remote ref).
  let headBranch = "";
  try {
    const { owner, repo } = parseOwnerRepo(args.ownerRepo);
    const ok = await octokit();
    const pr = await ok.rest.pulls.get({ owner, repo, pull_number: args.pullNumber });
    headBranch = pr.data.head?.ref ?? "";
  } catch (err) {
    warnings.push(
      `Could not read PR head branch before merge: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2. Merge the PR (delegates remote-branch cleanup based on flag)
  const message = await mergePullRequest({
    ownerRepo: args.ownerRepo,
    pullNumber: args.pullNumber,
    method: args.method,
    deleteRemoteBranch: args.deleteRemoteBranch,
  });

  // 3. Clean up the feature Lakebase branch
  let lakebaseBranchDeleted = false;
  if (deleteLakebaseBranch && headBranch) {
    const sanitized = sanitizeBranchName(headBranch);
    try {
      await deleteBranch({ instance: args.lakebaseInstance, branch: sanitized });
      lakebaseBranchDeleted = true;
    } catch (err) {
      warnings.push(
        `Lakebase branch "${sanitized}" cleanup failed (PR merge succeeded): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (deleteLakebaseBranch && !headBranch) {
    warnings.push("Skipped Lakebase branch cleanup, could not resolve PR head branch name");
  }

  return { message, headBranch, lakebaseBranchDeleted, warnings };
}
