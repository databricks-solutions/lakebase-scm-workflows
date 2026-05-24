// Self-hosted GitHub Actions runner management for Lakebase-paired
// projects. Ported from src/services/runnerService.ts.
//
// Runner binary is cached at ~/.cache/github-actions-runner/.
// Runner instances live at ~/.lakebase/runners/<projectName>/.
//
// Two public functions:
//   setupRunner, download + configure + start
//   removeRunner, stop + deregister + delete on-disk
//
// The preflightDatabricksAuth check from the extension is INTENTIONALLY
// not ported, it reads workspace .env and surfaces a VS Code-toned
// warning. Agent callers should run their own auth probe before invoking
// setupRunner if they care.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";
import * as tar from "tar";
import findJavaHome from "find-java-home";
import treeKill from "tree-kill";
import { delay } from "../util/delay.js";
import {
  createRegistrationToken,
  getRunnerIdByName,
  getRunnerStatus,
  deleteRunner as ghDeleteRunner,
} from "../github/runner.js";

const RUNNER_VERSION = "2.333.1";
const RUNNER_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const RUNNER_OS = process.platform === "darwin" ? "osx" : "linux";
const RUNNER_ARCHIVE = `actions-runner-${RUNNER_OS}-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz`;
const RUNNER_URL = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}`;
// Lazy lookups so HOME env changes (tests) take effect. The extension's
// version captured these at import time; we don't, because there's no
// performance cost worth the testability loss.
function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "github-actions-runner");
}
function runnersDir(): string {
  return path.join(os.homedir(), ".lakebase", "runners");
}

export interface RunnerInfo {
  name: string;
  dir: string;
  pid?: number;
  online: boolean;
}

export type RunnerReportFn = (msg: string) => void;

export function runnerDir(projectName: string): string {
  return path.join(runnersDir(), projectName);
}

export function runnerName(projectName: string): string {
  return `lakebase-${projectName}`;
}

/** Download the GitHub Actions runner tarball, cache it under ~/.cache. */
export async function ensureCachedArchive(): Promise<string> {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const cachedPath = path.join(dir, RUNNER_ARCHIVE);
  if (fs.existsSync(cachedPath)) return cachedPath;
  const response = await fetch(RUNNER_URL);
  if (!response.ok) {
    throw new Error(`Failed to download runner: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(cachedPath, buffer);
  return cachedPath;
}

/** Resolve JAVA_HOME: env var first, then find-java-home. */
export async function resolveJavaHome(): Promise<string | undefined> {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  return new Promise<string | undefined>((resolve) => {
    findJavaHome((err, javaHome) => resolve(err ? undefined : javaHome));
  });
}

/** True iff the runner's recorded pid is alive. */
export function isRunning(projectName: string): boolean {
  const pidFile = path.join(runnerDir(projectName), ".pid");
  if (!fs.existsSync(pidFile)) return false;
  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getRunnerInfo(projectName: string): RunnerInfo | undefined {
  const dir = runnerDir(projectName);
  if (!fs.existsSync(dir)) return undefined;
  const pidFile = path.join(dir, ".pid");
  let pid: number | undefined;
  if (fs.existsSync(pidFile)) {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  }
  return { name: runnerName(projectName), dir, pid, online: isRunning(projectName) };
}

let lastRunnerPid: number | undefined;

/** Stop the runner process (best-effort) and clean up stale state dirs. */
export function stopRunner(projectName: string): void {
  const dir = runnerDir(projectName);
  const pidFile = path.join(dir, ".pid");
  let pid = lastRunnerPid;
  if (fs.existsSync(pidFile)) {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
  }
  if (pid) {
    try {
      treeKill(pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else if (fs.existsSync(dir)) {
    // Legacy fallback for runners whose pid we don't know.
    try {
      cp.execSync(`pkill -9 -f "${dir.replace(/\//g, "\\/")}.*Runner" 2>/dev/null || true`, {
        timeout: 5000,
      });
    } catch {
      /* ignore */
    }
  }
  lastRunnerPid = undefined;

  for (const stale of ["_diag/pages", "_work/_temp", "_work/_actions"]) {
    const full = path.join(dir, stale);
    if (fs.existsSync(full)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  try {
    fs.mkdirSync(path.join(dir, "_diag", "pages"), { recursive: true });
  } catch {
    /* ignore */
  }
}

function resetRunnerConfig(dir: string, projectName: string): void {
  const stateFiles = [
    ".runner",
    ".credentials",
    ".credentials_rsaparams",
    ".path",
    ".service",
    "svc.sh",
    ".runner_migrated",
  ];
  for (const f of stateFiles) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  if (process.platform === "darwin") {
    const plist = path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      `actions.runner.${projectName}.plist`
    );
    if (fs.existsSync(plist)) {
      try {
        cp.execFileSync("launchctl", ["unload", plist], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(plist);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface SetupRunnerArgs {
  fullRepoName: string;
  projectName: string;
  report?: RunnerReportFn;
}

export async function setupRunner(args: SetupRunnerArgs): Promise<RunnerInfo> {
  const report = args.report ?? (() => {});
  const dir = runnerDir(args.projectName);
  const name = runnerName(args.projectName);

  stopRunner(args.projectName);

  report("Downloading runner binary...");
  const archive = await ensureCachedArchive();
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path.join(dir, "config.sh"))) {
    report("Extracting runner...");
    await tar.extract({ file: archive, cwd: dir });
  }

  const diagPages = path.join(dir, "_diag", "pages");
  if (fs.existsSync(diagPages)) {
    fs.rmSync(diagPages, { recursive: true, force: true });
    fs.mkdirSync(diagPages, { recursive: true });
  }

  const runnerFile = path.join(dir, ".runner");
  let needsConfig = !fs.existsSync(runnerFile);

  if (needsConfig) {
    resetRunnerConfig(dir, args.projectName);
  } else {
    let urlMismatch = false;
    try {
      const runnerJson = JSON.parse(fs.readFileSync(runnerFile, "utf-8"));
      const configuredUrl: string =
        runnerJson.gitHubUrl || runnerJson.serverUrl || runnerJson.agentUrl || "";
      const expectedUrl = `https://github.com/${args.fullRepoName}`;
      urlMismatch = !!configuredUrl && !configuredUrl.startsWith(expectedUrl);
    } catch {
      urlMismatch = true;
    }
    if (urlMismatch) {
      report("Runner configured against a different repo, resetting...");
      resetRunnerConfig(dir, args.projectName);
      needsConfig = true;
    } else {
      try {
        const id = await getRunnerIdByName(args.fullRepoName, name);
        if (!id) {
          report("Runner registration stale, reconfiguring...");
          resetRunnerConfig(dir, args.projectName);
          needsConfig = true;
        } else {
          report("Runner already configured, restarting...");
        }
      } catch {
        report("Could not verify runner, reconfiguring...");
        resetRunnerConfig(dir, args.projectName);
        needsConfig = true;
      }
    }
  }

  if (needsConfig) {
    report("Registering runner with GitHub...");
    const regToken = await createRegistrationToken(args.fullRepoName);
    cp.execSync(
      `./config.sh --url "https://github.com/${args.fullRepoName}" --token "${regToken}" --name "${name}" --labels self-hosted --unattended --replace`,
      { cwd: dir, timeout: 60_000 }
    );
  }

  report("Starting runner...");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const javaHome = await resolveJavaHome();
  if (javaHome && !env.JAVA_HOME) env.JAVA_HOME = javaHome;

  const child = cp.spawn("./run.sh", [], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env,
  });
  child.unref();
  lastRunnerPid = child.pid;
  if (child.pid) {
    fs.writeFileSync(path.join(dir, ".pid"), String(child.pid));
  }

  report("Waiting for runner to come online...");
  let online = false;
  for (let i = 0; i < 12; i++) {
    try {
      const status = await getRunnerStatus(args.fullRepoName, name);
      if (status === "online") {
        online = true;
        break;
      }
    } catch {
      /* retry */
    }
    await delay(5000);
  }
  if (!online) {
    throw new Error(`Runner "${name}" did not come online within 60 seconds`);
  }

  report("Runner is online.");
  return { name, dir, pid: child.pid, online: true };
}

export interface RemoveRunnerArgs {
  fullRepoName: string;
  projectName: string;
}

/** Stop, deregister from GitHub (best-effort), and delete the on-disk dir. */
export async function removeRunner(args: RemoveRunnerArgs): Promise<void> {
  const dir = runnerDir(args.projectName);
  const name = runnerName(args.projectName);
  stopRunner(args.projectName);
  await delay(2000);
  try {
    const id = await getRunnerIdByName(args.fullRepoName, name);
    if (id) await ghDeleteRunner(args.fullRepoName, id);
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
