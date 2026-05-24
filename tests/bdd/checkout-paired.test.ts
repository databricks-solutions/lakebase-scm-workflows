import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkoutPaired,
  type CheckoutPairedArgs,
  type CheckoutPairedResult,
  type CheckoutMode,
} from "../../scripts/lakebase/paired-branch.js";

const cliAvailable = (() => {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

const TEST_INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const TEST_BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const TEST_E2E = process.env.LAKEBASE_TEST_E2E === "1";
const live = cliAvailable && !!TEST_INSTANCE && !!TEST_BRANCH && TEST_E2E;

function makeFakeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-checkout-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  // Empty commit so HEAD resolves
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("checkoutPaired — shape", () => {
  it("type signature accepts the documented args (compile-only)", () => {
    const fn: typeof checkoutPaired = checkoutPaired;
    expect(typeof fn).toBe("function");
  });

  it("CheckoutMode is the documented union", () => {
    const modes: CheckoutMode[] = ["trunk", "staging", "feature", "feature-created"];
    expect(modes.length).toBe(4);
  });

  it("type CheckoutPairedResult has the documented fields", () => {
    const sample: CheckoutPairedResult = {
      branchId: "x",
      mode: "feature",
      matchedLakebaseBranch: "x",
      endpointHost: "h",
      databaseUrl: "u",
      envUpdated: true,
      warnings: [],
    };
    expect(sample.warnings).toHaveLength(0);
  });
});

describe("checkoutPaired — input validation", () => {
  it("throws when no instance can be resolved (no .env, no --instance)", async () => {
    const dir = makeFakeGitRepo();
    try {
      await expect(
        checkoutPaired({ cwd: dir })
      ).rejects.toThrow(/Could not resolve Lakebase instance/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when git HEAD is detached", async () => {
    const dir = makeFakeGitRepo();
    try {
      // Detach HEAD onto the only commit
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      execFileSync("git", ["checkout", "--detach", sha], { cwd: dir, stdio: "ignore" });
      // Write a .env so instance resolves first; the error we want is the HEAD one
      fs.writeFileSync(path.join(dir, ".env"), "LAKEBASE_PROJECT_ID=fake\n");
      await expect(
        checkoutPaired({ cwd: dir })
      ).rejects.toThrow(/detached HEAD|Cannot resolve current git branch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!live)("checkoutPaired — destructive live E2E", () => {
  // Live E2E here only covers the FEATURE mode against an existing test branch.
  // Trunk and staging modes need workspace-specific aliases configured; skip
  // those at the live tier and rely on integration tests in the extension.
  it("pairs an existing feature branch and writes a valid .env", async () => {
    const dir = makeFakeGitRepo();
    try {
      // Stand the git branch up with the same sanitized name as the
      // pre-existing test Lakebase branch.
      execFileSync("git", ["checkout", "-b", TEST_BRANCH!], { cwd: dir, stdio: "ignore" });

      // Bootstrap .env with the project id so the function can find the instance.
      fs.writeFileSync(
        path.join(dir, ".env"),
        `LAKEBASE_PROJECT_ID=${TEST_INSTANCE}\n`
      );

      const result = await checkoutPaired({
        cwd: dir,
        autoCreate: false, // don't create a Lakebase branch we'd have to clean up
      });

      expect(result.envUpdated).toBe(true);
      expect(result.endpointHost).toBeTruthy();
      expect(result.databaseUrl).toMatch(/^postgresql:\/\//);

      const env = fs.readFileSync(path.join(dir, ".env"), "utf-8");
      expect(env).toContain("LAKEBASE_HOST=");
      expect(env).toContain(`LAKEBASE_BRANCH_ID=${result.matchedLakebaseBranch}`);
      expect(env).toContain("DATABASE_URL=postgresql://");
      expect(env).toContain("LAKEBASE_PROJECT_ID="); // preserved
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("checkoutPaired — skip-when-env-missing", () => {
  it("documents the skip reason when destructive E2E is gated off", () => {
    if (live) return;
    // eslint-disable-next-line no-console
    console.log(
      !cliAvailable
        ? "`databricks` CLI not available — destructive checkoutPaired E2E skipped."
        : !TEST_E2E
          ? "LAKEBASE_TEST_E2E!=1 — destructive checkoutPaired E2E skipped."
          : "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_BRANCH not set — destructive checkoutPaired E2E skipped."
    );
    expect(live).toBe(false);
  });
});
