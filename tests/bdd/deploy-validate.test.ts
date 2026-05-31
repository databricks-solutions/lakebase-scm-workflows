import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateApp } from "../../scripts/lakebase/deploy-validate";

// validateApp shells out to `databricks apps validate`. The kit's
// convention for CLI-wrapping primitives: hermetic tests skip when the
// CLI isn't installed (mirrors branch-utils, branch-create-delete).
// Live coverage runs end-to-end against a real workspace via
// run-all-live-tests.sh; this file's hermetic gate covers the structured
// return shape + the missing-profile fast fail.

function hasCli(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

const CLI_AVAILABLE = hasCli();
const PROFILE = process.env.LAKEBASE_TEST_PROFILE;
// Tests that need a working profile (validate hits the workspace to
// resolve auth). Skip when the live driver hasn't exported one.
const RUN_LIVE = CLI_AVAILABLE && !!PROFILE;

let projectDir: string;

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "deploy-validate-"));
  // Minimal node project that validate's project-type detector accepts.
  // Per Q1 (ADR-0002), validate runs install + typegen + lint + typecheck
  // + build + tests; the no-op scripts below make each step trivial so
  // the test stays fast.
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "deploy-validate-fixture",
        version: "0.0.0",
        scripts: {
          build: "echo 'no-op build'",
          lint: "echo 'no-op lint'",
          typecheck: "echo 'no-op typecheck'",
          test: "echo 'no-op test'",
        },
      },
      null,
      2
    ) + "\n"
  );
});

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe("validateApp: hermetic (skip-when-cli-or-profile-missing)", () => {
  it.skipIf(!RUN_LIVE)("returns ok=true on a project the CLI accepts", async () => {
    const result = await validateApp({
      workspaceRoot: projectDir,
      profile: PROFILE!,
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // The CLI prints its progress output (including the success marker)
    // to stderr when running without a TTY; assert against the combined
    // stream so the test stays decoupled from that stylistic detail.
    expect(result.stdout + result.stderr).toContain("validation checks passed");
  }, 90_000);

  it.skipIf(!RUN_LIVE)("returns ok=false on a directory with no project markers", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "deploy-validate-empty-"));
    try {
      const result = await validateApp({
        workspaceRoot: emptyDir,
        profile: PROFILE!,
        timeoutMs: 30_000,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      // CLI reports the missing-project-type error.
      expect(result.stderr + result.stdout).toMatch(/no supported project type/i);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!CLI_AVAILABLE)("returns a structured result for any exit code (no throw)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "deploy-validate-noprofile-"));
    try {
      const result = await validateApp({
        workspaceRoot: emptyDir,
        // Use a profile that almost certainly doesn't exist locally so
        // validate fails fast on auth resolution; the contract is "still
        // returns a structured result, never throws".
        profile: "this-profile-should-not-exist-1234567890",
        timeoutMs: 30_000,
      });
      expect(result.ok).toBe(false);
      expect(typeof result.exitCode).toBe("number");
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("documents the skip reason when CLI or profile is missing", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; live deploy-validate suite skipped.");
    } else if (!PROFILE) {
      console.log("LAKEBASE_TEST_PROFILE not set; live deploy-validate suite skipped.");
    }
    expect(true).toBe(true);
  });
});

describe("validateApp: argument validation", () => {
  it("rejects when CLI is missing entirely (synthetic infra failure path)", async () => {
    // Override PATH so the spawn fails to find `databricks`. This exercises
    // the "error" event branch (reject path), which is otherwise hard to
    // hit when CI has the CLI installed.
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        validateApp({
          workspaceRoot: tmpdir(),
          profile: "any",
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/failed to start|ENOENT/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);
});
