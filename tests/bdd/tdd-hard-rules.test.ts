import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SKILL_PATH = join(
  __dirname,
  "..",
  "..",
  "skills",
  "lakebase-tdd-workflows",
  "SKILL.md"
);

const NAV_PATH = join(
  __dirname,
  "..",
  "..",
  "skills",
  "lakebase-tdd-workflows",
  "agents",
  "navigator.md"
);

const DRV_PATH = join(
  __dirname,
  "..",
  "..",
  "skills",
  "lakebase-tdd-workflows",
  "agents",
  "driver.md"
);

const NINE_RULES_PHRASES = [
  "immutable until the test list itself is renegotiated",
  "minimal *honest* code",
  "would a fresh reader infer the right concept",
  "outermost public boundary",
  "correct refactor should not change the outer-boundary tests",
  "never make a private method public",
  "leading indicator is",
  "spike code is throwaway",
  "iterative refinement",
];

describe("lakebase-tdd-workflows hard rules", () => {
  const skill = readFileSync(SKILL_PATH, "utf8");

  it("SKILL.md contains a ## Hard rules section", () => {
    expect(skill).toMatch(/^##\s+Hard rules/m);
  });

  it("SKILL.md ships a ## How to use section with worked examples", () => {
    expect(skill).toMatch(/^##\s+How to use/m);
    // Flow 1: spec authoring + drift validation.
    expect(skill).toMatch(/Author a feature spec/i);
    // Flow 2: N=1 default — lead with feature-oriented language.
    expect(skill).toMatch(/Build a feature end-to-end/i);
    expect(skill).toMatch(/N=1 default/i);
    // Flow 3: N>=2 parallel experiments.
    expect(skill).toMatch(/Race parallel experiments/i);
  });

  it("Lexicon makes feature-vs-experiment terminology explicit for N=1", () => {
    // When N=1 the experiment IS the feature; SKILL.md must say so somewhere in the lexicon.
    expect(skill).toMatch(/experiment IS the feature/i);
  });

  it("SKILL.md has at least 9 numbered rules", () => {
    const numbered = skill.match(/^[0-9]+\./gm) ?? [];
    expect(numbered.length).toBeGreaterThanOrEqual(9);
  });

  for (const phrase of NINE_RULES_PHRASES) {
    it(`SKILL.md hard rules include: "${phrase}"`, () => {
      // Rule content match is case-insensitive — sentence-start capitalization is incidental,
      // the rule wording itself is what matters.
      expect(skill.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  it("SKILL.md points to navigator.md and driver.md for per-role specialization", () => {
    expect(skill).toContain("agents/navigator.md");
    expect(skill).toContain("agents/driver.md");
  });

  it("navigator.md affirms tests are immutable between approved gates", () => {
    const nav = readFileSync(NAV_PATH, "utf8");
    expect(nav).toMatch(/immutable/i);
  });

  it("driver.md prohibits deleting or weakening tests", () => {
    const drv = readFileSync(DRV_PATH, "utf8");
    expect(drv).toMatch(/never delete a test/i);
    expect(drv).toMatch(/never weaken/i);
  });

  it("driver.md prohibits mocking the database", () => {
    const drv = readFileSync(DRV_PATH, "utf8");
    expect(drv.toLowerCase()).toContain("no mocks for the database");
  });
});
