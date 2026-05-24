import { describe, it, expect } from "vitest";
import {
  GitHubPullRequestError,
  createPullRequest,
  getPullRequest,
  getPullRequestReviews,
  getPullRequestFiles,
  getPullRequestComments,
  listIssueComments,
  listWorkflowRuns,
  mergePullRequest,
  mergePairedPullRequest,
  type PullRequestInfo,
  type PullRequestReview,
  type PullRequestFile,
  type WorkflowRunSummary,
  type MergePairedPullRequestResult,
} from "../../scripts/github/pr.js";

describe("GitHubPullRequestError", () => {
  it("carries the right name and status", () => {
    const err = new GitHubPullRequestError("oops", 404);
    expect(err.name).toBe("GitHubPullRequestError");
    expect(err.message).toBe("oops");
    expect(err.status).toBe(404);
  });
});

describe("github/pr – signatures (compile-only)", () => {
  it("exposes the primitive PR functions", () => {
    expect(typeof createPullRequest).toBe("function");
    expect(typeof getPullRequest).toBe("function");
    expect(typeof getPullRequestReviews).toBe("function");
    expect(typeof getPullRequestFiles).toBe("function");
    expect(typeof getPullRequestComments).toBe("function");
    expect(typeof listIssueComments).toBe("function");
    expect(typeof listWorkflowRuns).toBe("function");
    expect(typeof mergePullRequest).toBe("function");
  });

  it("exposes the paired merge op", () => {
    expect(typeof mergePairedPullRequest).toBe("function");
  });
});

describe("github/pr – type shape sanity", () => {
  it("PullRequestInfo has the documented fields", () => {
    const sample: PullRequestInfo = {
      number: 1,
      title: "x",
      url: "u",
      state: "OPEN",
      isDraft: false,
      ciStatus: "pending",
      checks: [],
      headBranch: "h",
      baseBranch: "b",
    };
    expect(sample.checks).toEqual([]);
  });

  it("PullRequestReview / PullRequestFile compile", () => {
    const review: PullRequestReview = { author: "a", state: "APPROVED", body: "" };
    const file: PullRequestFile = { path: "p", status: "added", additions: 1, deletions: 0 };
    const run: WorkflowRunSummary = { id: 1, name: "n", status: "completed", conclusion: "success", branch: "main", event: "push" };
    expect(review.state).toBe("APPROVED");
    expect(file.status).toBe("added");
    expect(run.conclusion).toBe("success");
  });

  it("MergePairedPullRequestResult has documented fields", () => {
    const r: MergePairedPullRequestResult = {
      message: "m",
      headBranch: "h",
      lakebaseBranchDeleted: true,
      warnings: [],
    };
    expect(r.warnings).toHaveLength(0);
  });
});

describe("github/pr – graceful no-token degradation", () => {
  // These functions catch RequestError and return [] / undefined for "read"
  // semantics so callers can use them in optional contexts (e.g. an extension
  // surface that hasn't authenticated yet). Verify the contract.
  it("read functions return empty/undefined when auth is unavailable", async () => {
    const noToken = !process.env.GITHUB_TOKEN;
    if (!noToken) {
      // eslint-disable-next-line no-console
      console.log("GITHUB_TOKEN set – skipping no-token degradation check");
      return;
    }
    // Use a clearly non-existent owner/repo so we don't accidentally hit a real one
    const fake = "definitely-not-a-real-owner/definitely-not-a-real-repo";
    expect(await getPullRequest(fake, "x")).toBeUndefined();
    expect(await getPullRequestReviews(fake, 1)).toEqual([]);
    expect(await getPullRequestFiles(fake, 1)).toEqual([]);
    expect(await getPullRequestComments(fake, 1)).toEqual([]);
    expect(await listIssueComments(fake, 1)).toEqual([]);
    expect(await listWorkflowRuns(fake, 1)).toEqual([]);
  }, 30_000);
});
