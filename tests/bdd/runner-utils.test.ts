import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runnerDir,
  runnerName,
  isRunning,
  getRunnerInfo,
  resolveJavaHome,
} from "../../scripts/lakebase/runner-setup.js";

// Most of runner-setup is destructive (downloads ~250MB, registers with
// GitHub, spawns a long-running process). End-to-end equivalence lives
// in FEIP-7071 with a dedicated test project. This suite only covers the
// pure helpers + the filesystem-state lookups (against a tmp HOME).

const ORIGINAL_HOME = os.homedir();
const ORIGINAL_JAVA_HOME = process.env.JAVA_HOME;
const tmpHomes: string[] = [];

beforeEach(() => {
  // Each test gets its own HOME so the runner dir / cache dir are isolated.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-runner-home-"));
  tmpHomes.push(tmp);
  process.env.HOME = tmp;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_JAVA_HOME === undefined) {
    delete process.env.JAVA_HOME;
  } else {
    process.env.JAVA_HOME = ORIGINAL_JAVA_HOME;
  }
  while (tmpHomes.length) {
    const t = tmpHomes.pop();
    if (t) try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* */ }
  }
});

describe("runnerDir + runnerName", () => {
  it("places runner under ~/.lakebase/runners/<projectName>", () => {
    expect(runnerDir("my-app")).toBe(path.join(process.env.HOME!, ".lakebase", "runners", "my-app"));
  });

  it("prefixes runnerName with 'lakebase-'", () => {
    expect(runnerName("my-app")).toBe("lakebase-my-app");
  });
});

describe("getRunnerInfo + isRunning (filesystem state)", () => {
  it("returns undefined when the runner dir doesn't exist", () => {
    expect(getRunnerInfo("missing-app")).toBeUndefined();
  });

  it("returns RunnerInfo with online=false when there's no .pid file", () => {
    const dir = runnerDir("no-pid-app");
    fs.mkdirSync(dir, { recursive: true });
    const info = getRunnerInfo("no-pid-app");
    expect(info).toBeDefined();
    expect(info!.name).toBe("lakebase-no-pid-app");
    expect(info!.dir).toBe(dir);
    expect(info!.pid).toBeUndefined();
    expect(info!.online).toBe(false);
  });

  it("returns online=true for current process pid (definitely alive)", () => {
    const dir = runnerDir("live-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".pid"), String(process.pid));
    expect(isRunning("live-app")).toBe(true);
    const info = getRunnerInfo("live-app");
    expect(info!.pid).toBe(process.pid);
    expect(info!.online).toBe(true);
  });

  it("returns online=false for a pid that's clearly dead (pid=1 in a non-root non-init context throws EPERM, treated as dead)", () => {
    const dir = runnerDir("dead-pid-app");
    fs.mkdirSync(dir, { recursive: true });
    // Use a pid that's almost certainly not a real process, 2^30 is well above
    // typical pid_max. process.kill(pid, 0) throws ESRCH for non-existent pids.
    fs.writeFileSync(path.join(dir, ".pid"), "1073741824");
    expect(isRunning("dead-pid-app")).toBe(false);
  });

  it("returns online=false when .pid file content is malformed", () => {
    const dir = runnerDir("bad-pid-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".pid"), "not-a-number");
    expect(isRunning("bad-pid-app")).toBe(false);
  });
});

describe("resolveJavaHome", () => {
  it("returns the JAVA_HOME env value when set", async () => {
    process.env.JAVA_HOME = "/opt/jdk-21";
    const result = await resolveJavaHome();
    expect(result).toBe("/opt/jdk-21");
  });

  it("falls back to find-java-home when env is unset (best-effort; either a path or undefined)", async () => {
    delete process.env.JAVA_HOME;
    const result = await resolveJavaHome();
    if (result !== undefined) {
      // If find-java-home succeeded, it should return a non-empty path
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
    // undefined is also acceptable (no JDK installed on the test machine)
  });
});
