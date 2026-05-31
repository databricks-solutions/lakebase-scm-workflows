// Live end-to-end test for FEIP-7130 slice 3's ensureAppEndpoint.
//
// Scaffolds a minimal Node.js HTTP server, generates app.yaml via
// slice 2's generateAppYaml, calls ensureAppEndpoint to actually
// upload + create + deploy the app to the workspace, asserts the URL
// is returned, then deletes the app via `databricks apps delete`.
//
// Real Databricks resources are created. The app endpoint stays
// distinct from the orchestrator-level Lakebase project so the
// teardown-on-green contract is per-test (mirrors FEIP-7138's pattern
// post-fix).
//
// Heavy: a full deploy takes 5-10 minutes. Gated on LAKEBASE_TEST_E2E +
// the standard live-driver env set so this only runs when the kit's
// scripts/run-all-live-tests.sh has provisioned a workspace + Lakebase
// project.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAppYaml } from "../../scripts/lakebase/deploy-app-yaml";
import {
  ensureAppEndpoint,
  getAppEndpoint,
} from "../../scripts/lakebase/deploy-app-endpoint";
import { DeployTarget } from "../../scripts/lakebase/deploy-targets";
import { exec } from "../../scripts/util/exec";

// /Workspace/Users/ is platform-protected; only existing per-user homes
// are writable. The live test must put its source under the
// authenticated user's home (which exists by default for any user who
// has signed in). Resolve via `current-user me`.
function resolveUserHome(profile: string): string {
  try {
    const out = execFileSync(
      "databricks",
      ["current-user", "me", "--profile", profile, "-o", "json"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const start = out.indexOf("{");
    const me = JSON.parse(out.slice(start));
    const userName = typeof me.userName === "string" ? me.userName : "";
    if (!userName) throw new Error("current-user me returned empty userName");
    return `/Workspace/Users/${userName}`;
  } catch (err) {
    throw new Error(`Could not resolve workspace user home: ${(err as Error).message}`);
  }
}

function hasCli(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

const CLI_AVAILABLE = hasCli();
const E2E = process.env.LAKEBASE_TEST_E2E === "1";
const HOST = process.env.DATABRICKS_HOST;
const PROFILE = process.env.LAKEBASE_TEST_PROFILE;
const INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const RUN_LIVE = CLI_AVAILABLE && E2E && !!HOST && !!PROFILE && !!INSTANCE && !!BRANCH;

// App name: must be <= 26 chars, lowercase letters/numbers/hyphens only.
// Use a short prefix + 8-char unix-timestamp suffix.
function buildAppName(): string {
  const ts = Date.now().toString(36).slice(-8);
  return `kit-deploy-test-${ts}`;
}

let projectDir: string;
let appName: string;
let workspacePath: string;
let allPassed = false;

beforeAll(() => {
  if (!RUN_LIVE) return;
  appName = buildAppName();
  // Per-app workspace path under the AUTHENTICATED user's home dir.
  // /Workspace/Users/ is platform-protected; only existing user homes
  // are writable. Resolve dynamically so the test works for any
  // contributor running the live driver.
  workspacePath = `${resolveUserHome(PROFILE!)}/${appName}`;
  projectDir = mkdtempSync(join(tmpdir(), "deploy-endpoint-live-"));

  writeFileSync(
    join(projectDir, "server.js"),
    `const http = require("http");
const port = process.env.DATABRICKS_APP_PORT || 8000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("hello from kit-deploy-test");
}).listen(port, () => {
  console.log("kit-deploy-test listening on", port);
});
`,
  );

  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "kit-deploy-test",
        version: "0.0.0",
        scripts: {
          start: "node server.js",
          build: "echo 'no-op build'",
          lint: "echo 'no-op lint'",
          typecheck: "echo 'no-op typecheck'",
          test: "echo 'no-op test'",
        },
      },
      null,
      2,
    ) + "\n",
  );

  // Generate the canonical app.yaml via slice 2's generator. databricks.yml
  // is intentionally absent: per ADR-0002 amendment, Lakebase apps use the
  // per-step deploy pattern (no bundle config), since the bundle's
  // `database:` resource only references Database Instances, not Lakebase
  // Postgres Projects.
  const target: DeployTarget = {
    workspace_profile: PROFILE!,
    workspace_path: workspacePath,
    app_name: appName,
    lakebase_project: INSTANCE!,
    lakebase_branch: BRANCH!,
  };
  writeFileSync(join(projectDir, "app.yaml"), generateAppYaml(target));
});

afterAll(async () => {
  if (!RUN_LIVE) return;
  if (!allPassed) {
    console.log("");
    console.log("[LEAVE-INTACT] deploy-app-endpoint failed; preserving app for inspection.");
    console.log(`         app:     ${appName}`);
    console.log(`         wsPath:  ${workspacePath}`);
    console.log("         To clean up manually:");
    console.log(`           databricks apps delete "${appName}" --profile "${PROFILE}"`);
    console.log(`           databricks workspace delete "${workspacePath}" --recursive --profile "${PROFILE}"`);
    console.log("");
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    return;
  }
  console.log("");
  console.log(`[TEARDOWN] deploy-app-endpoint passed; deleting app ${appName} + workspace files.`);
  try {
    await exec(`databricks apps delete "${appName}" --profile "${PROFILE}"`, { timeout: 60_000 });
  } catch (err) {
    console.log(`  [teardown] apps delete failed: ${(err as Error).message}`);
  }
  try {
    await exec(
      `databricks workspace delete "${workspacePath}" --recursive --profile "${PROFILE}"`,
      { timeout: 60_000 },
    );
  } catch (err) {
    console.log(`  [teardown] workspace delete failed: ${(err as Error).message}`);
  }
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!RUN_LIVE)(
  "ensureAppEndpoint end-to-end (live, FEIP-7130 slice 3)",
  () => {
    it("uploads, creates, deploys, returns a URL, app is reachable via apps get", async () => {
      const result = await ensureAppEndpoint({
        workspaceRoot: projectDir,
        workspacePath,
        profile: PROFILE!,
        appName,
        deployTimeoutMs: 900_000, // 15-min budget; cold-start can take long
      });

      if (!result.ok) {
        console.log("[deploy] stdout:\n" + result.deployStdout);
        console.log("[deploy] stderr:\n" + result.deployStderr);
        if (result.upload.errors.length > 0) {
          console.log("[upload] errors:", JSON.stringify(result.upload.errors, null, 2));
        }
      }

      expect(result.upload.errors).toEqual([]);
      expect(result.upload.filesUploaded).toBeGreaterThan(0);
      expect(result.created).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.url).toBeTruthy();
      expect(result.url!.startsWith("https://")).toBe(true);

      // Independent sanity check: a follow-up getAppEndpoint sees the
      // same app + URL.
      const lookup = await getAppEndpoint({ appName, profile: PROFILE! });
      expect(lookup.exists).toBe(true);
      expect(lookup.url).toBe(result.url);

      allPassed = true;
    }, 1_200_000); // 20-min outer wall-clock budget
  },
);

describe("ensureAppEndpoint live (skip-when-env-missing)", () => {
  it("documents the skip reason when live driver vars are absent", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; ensureAppEndpoint live test skipped.");
    } else if (!E2E || !HOST || !PROFILE) {
      console.log("LAKEBASE_TEST_E2E=1 + DATABRICKS_HOST + LAKEBASE_TEST_PROFILE required; live test skipped.");
    } else if (!INSTANCE || !BRANCH) {
      console.log("LAKEBASE_TEST_INSTANCE + LAKEBASE_TEST_BRANCH required; live test skipped.");
    }
    expect(true).toBe(true);
  });
});
