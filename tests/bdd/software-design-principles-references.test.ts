import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SKILL_DIR = join(__dirname, "..", "..", "skills", "software-design-principles");
const REFS_DIR = join(SKILL_DIR, "references");

describe("software-design-principles skill", () => {
  it("SKILL.md exists with name + description frontmatter", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---[\s\S]*?name:\s*software-design-principles/m);
    expect(skill).toMatch(/^description:/m);
  });

  it("ships the canonical reference set", () => {
    const expected = [
      "solid.md",
      "dry.md",
      "dtsttcpw.md",
      "clean-code.md",
      "layered-architecture.md",
      "cross-cutting-concerns.md",
      "nfrs.md",
    ];
    const present = readdirSync(REFS_DIR).filter((f) => f.endsWith(".md"));
    for (const ref of expected) {
      expect(present, `expected reference ${ref}`).toContain(ref);
    }
  });

  it("every reference file is non-empty and well-formed markdown", () => {
    const files = readdirSync(REFS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const stat = statSync(join(REFS_DIR, f));
      expect(stat.size, `${f} should be non-empty`).toBeGreaterThan(100);
      const body = readFileSync(join(REFS_DIR, f), "utf8");
      expect(body, `${f} should start with a markdown heading`).toMatch(/^#\s+/m);
    }
  });

  it("SKILL.md links to every shipped reference", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const files = readdirSync(REFS_DIR).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      expect(skill, `SKILL.md should reference references/${f}`).toContain(`references/${f}`);
    }
  });

  it("SKILL.md ships the Architectural Concerns Mapping table", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(skill).toMatch(/Architectural Concerns Mapping/i);
    expect(skill).toMatch(/\| Concern \|/);
  });
});
