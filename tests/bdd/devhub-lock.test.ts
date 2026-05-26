// FEIP-7143: hermetic coverage for devhub.lock parsing.
//
// The lockfile is the single source of truth for which devhub commit
// the substrate pins to. The parser enforces:
//   * required fields {repo, ref, skills}
//   * `ref` must be a 40-char commit SHA (no branch names, no tags)
//
// These invariants are what make install-time fetches reproducible
// and what FEIP-7144's drift detector relies on. If either invariant
// silently weakens, drift goes silent again and we re-enter the world
// FEIP-7143 was created to leave.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readLock } from "../../scripts/sync-devhub-skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeLock(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devhub-lock-"));
  tmpDirs.push(dir);
  const p = path.join(dir, "devhub.lock");
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

describe("devhub.lock parser (FEIP-7143)", () => {
  it("accepts a well-formed lock with a 40-char SHA ref", () => {
    const p = writeLock({
      repo: "databricks/devhub",
      ref: "0b6297e1c4b6398fdd8d8f1631461c46f54c2d11",
      skills: { "databricks-lakebase": ["SKILL.md"] },
    });
    const lock = readLock(p);
    expect(lock.repo).toBe("databricks/devhub");
    expect(lock.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.skills["databricks-lakebase"]).toEqual(["SKILL.md"]);
  });

  it("rejects a lock missing required fields", () => {
    const p = writeLock({ repo: "databricks/devhub" });
    expect(() => readLock(p)).toThrow(/missing required fields/);
  });

  it("rejects a branch name as ref (must be commit SHA)", () => {
    const p = writeLock({
      repo: "databricks/devhub",
      ref: "main",
      skills: { "databricks-lakebase": ["SKILL.md"] },
    });
    expect(() => readLock(p)).toThrow(/40-char commit SHA/);
  });

  it("rejects a short SHA prefix (must be 40 chars)", () => {
    const p = writeLock({
      repo: "databricks/devhub",
      ref: "0b6297e",
      skills: { "databricks-lakebase": ["SKILL.md"] },
    });
    expect(() => readLock(p)).toThrow(/40-char commit SHA/);
  });

  it("rejects a malformed JSON file", () => {
    const p = writeLock("{ this is not valid json");
    expect(() => readLock(p)).toThrow();
  });
});

describe("substrate's checked-in devhub.lock", () => {
  it("parses cleanly with the parser's invariants", () => {
    // Reads the real lockfile at the repo root; catches accidental
    // weakenings (e.g., a contributor pinning to `main` instead of a
    // SHA, which would re-introduce silent drift).
    const repoLock = path.join(__dirname, "..", "..", "devhub.lock");
    const lock = readLock(repoLock);
    expect(lock.repo).toBe("databricks/devhub");
    expect(lock.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(lock.skills).length).toBeGreaterThan(0);
  });
});
