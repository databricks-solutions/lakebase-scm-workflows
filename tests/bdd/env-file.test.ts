import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeEnvFile } from "../../scripts/lakebase/env-file.js";

const TMP_PREFIX = path.join(os.tmpdir(), "lbscm-env-file-");
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(TMP_PREFIX);
  tmpDirs.push(dir);
  return dir;
}

describe("writeEnvFile", () => {
  it("writes a .env file at projectDir/.env with the required keys", () => {
    const dir = mkTmp();
    const envPath = writeEnvFile({
      projectDir: dir,
      databricksHost: "https://workspace.cloud.databricks.com",
      lakebaseProjectId: "proj-test-abc",
    });
    expect(envPath).toBe(path.join(dir, ".env"));
    const contents = fs.readFileSync(envPath, "utf8");
    expect(contents).toMatch(/^DATABRICKS_HOST=https:\/\/workspace\.cloud\.databricks\.com$/m);
    expect(contents).toMatch(/^LAKEBASE_PROJECT_ID=proj-test-abc$/m);
  });

  it("strips trailing slashes from the host", () => {
    const dir = mkTmp();
    writeEnvFile({
      projectDir: dir,
      databricksHost: "https://workspace.cloud.databricks.com///",
      lakebaseProjectId: "p",
    });
    const contents = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(contents).toMatch(/^DATABRICKS_HOST=https:\/\/workspace\.cloud\.databricks\.com$/m);
    expect(contents).not.toMatch(/databricks\.com\//);
  });

  it("leaves connection values commented (filled in per-branch later)", () => {
    const dir = mkTmp();
    writeEnvFile({ projectDir: dir, databricksHost: "https://h", lakebaseProjectId: "p" });
    const contents = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(contents).toMatch(/^# DATABASE_URL=$/m);
    expect(contents).toMatch(/^# DB_USERNAME=$/m);
    expect(contents).toMatch(/^# DB_PASSWORD=$/m);
  });

  it("overwrites an existing .env", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, ".env"), "STALE=true\n");
    writeEnvFile({ projectDir: dir, databricksHost: "https://h", lakebaseProjectId: "p" });
    const contents = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(contents).not.toMatch(/STALE/);
    expect(contents).toMatch(/^LAKEBASE_PROJECT_ID=p$/m);
  });
});
