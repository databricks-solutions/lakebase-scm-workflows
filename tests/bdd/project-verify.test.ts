import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyHooks, verifyWorkflows, verifyProject } from "../../scripts/lakebase/project-verify.js";

const TMP_PREFIX = path.join(os.tmpdir(), "lbscm-verify-");
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(TMP_PREFIX);
  tmpDirs.push(dir);
  return dir;
}

function touch(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
}

describe("verifyHooks", () => {
  it("returns all-false when no .git/hooks dir exists", () => {
    const dir = mkTmp();
    expect(verifyHooks(dir)).toEqual({
      postCheckout: false,
      prepareCommitMsg: false,
      prePush: false,
    });
  });

  it("detects each of the three hook files independently", () => {
    const dir = mkTmp();
    touch(path.join(dir, ".git", "hooks", "post-checkout"));
    touch(path.join(dir, ".git", "hooks", "pre-push"));
    expect(verifyHooks(dir)).toEqual({
      postCheckout: true,
      prepareCommitMsg: false,
      prePush: true,
    });
  });

  it("returns all-true when all three hooks are present", () => {
    const dir = mkTmp();
    for (const h of ["post-checkout", "prepare-commit-msg", "pre-push"]) {
      touch(path.join(dir, ".git", "hooks", h));
    }
    expect(verifyHooks(dir)).toEqual({
      postCheckout: true,
      prepareCommitMsg: true,
      prePush: true,
    });
  });
});

describe("verifyWorkflows", () => {
  it("returns all-false when no .github/workflows dir exists", () => {
    expect(verifyWorkflows(mkTmp())).toEqual({ pr: false, merge: false });
  });

  it("detects pr.yml and merge.yml independently", () => {
    const dir = mkTmp();
    touch(path.join(dir, ".github", "workflows", "pr.yml"));
    expect(verifyWorkflows(dir)).toEqual({ pr: true, merge: false });
  });
});

describe("verifyProject (combined)", () => {
  it("emits two warnings when both hooks and workflows are missing", () => {
    const result = verifyProject(mkTmp());
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.some((w) => /hooks/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /workflows/.test(w))).toBe(true);
  });

  it("emits zero warnings when everything is present", () => {
    const dir = mkTmp();
    for (const h of ["post-checkout", "prepare-commit-msg", "pre-push"]) {
      touch(path.join(dir, ".git", "hooks", h));
    }
    for (const w of ["pr.yml", "merge.yml"]) {
      touch(path.join(dir, ".github", "workflows", w));
    }
    expect(verifyProject(dir).warnings).toEqual([]);
  });
});
