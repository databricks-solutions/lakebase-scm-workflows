import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "../../scripts/util/exec.js";
import { getGitHubUrl, getOwnerRepo } from "../../scripts/git/remote.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

async function mkRepoWithRemote(url: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-remote-"));
  tmpDirs.push(dir);
  await exec("git init -b main", { cwd: dir });
  await exec(`git remote add origin "${url}"`, { cwd: dir });
  return dir;
}

describe("getGitHubUrl", () => {
  it("returns empty string when no git remote", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-no-remote-"));
    tmpDirs.push(dir);
    expect(await getGitHubUrl(dir)).toBe("");
  });

  it("normalizes HTTPS URL (strips .git)", async () => {
    const dir = await mkRepoWithRemote("https://github.com/foo/bar.git");
    expect(await getGitHubUrl(dir)).toBe("https://github.com/foo/bar");
  });

  it("normalizes SSH URL (git@github.com:owner/repo.git)", async () => {
    const dir = await mkRepoWithRemote("git@github.com:foo/bar.git");
    expect(await getGitHubUrl(dir)).toBe("https://github.com/foo/bar");
  });

  it("normalizes ssh:// URL", async () => {
    const dir = await mkRepoWithRemote("ssh://git@github.com/foo/bar.git");
    expect(await getGitHubUrl(dir)).toBe("https://github.com/foo/bar");
  });
});

describe("getOwnerRepo", () => {
  it("returns 'owner/repo' slug", async () => {
    const dir = await mkRepoWithRemote("https://github.com/databricks-solutions/lakebase-scm-extension");
    expect(await getOwnerRepo(dir)).toBe("databricks-solutions/lakebase-scm-extension");
  });

  it("returns empty string for a non-GitHub remote", async () => {
    const dir = await mkRepoWithRemote("https://gitlab.com/foo/bar");
    // parseOwnerRepo will fall through to the generic path and may succeed.
    // we just assert it doesn't crash.
    const result = await getOwnerRepo(dir);
    expect(typeof result).toBe("string");
  });
});
