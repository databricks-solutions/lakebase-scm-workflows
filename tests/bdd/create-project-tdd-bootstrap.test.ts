import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { layDownTddScaffold } from "../../scripts/lakebase/create-project";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tdd-bootstrap-project-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("layDownTddScaffold (hermetic)", () => {
  it("copies the .tdd/ skeleton into the project directory", () => {
    layDownTddScaffold(projectDir);
    expect(existsSync(join(projectDir, ".tdd", "README.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".tdd", "spec.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".tdd", "workflow-state.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".tdd", "selection-log.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".tdd", "smells.json"))).toBe(true);
  });

  it("workflow-state.json seed has phase=discovery", () => {
    layDownTddScaffold(projectDir);
    const state = JSON.parse(readFileSync(join(projectDir, ".tdd", "workflow-state.json"), "utf8"));
    expect(state.phase).toBe("discovery");
  });

  it("is idempotent – running twice does not overwrite existing .tdd/", () => {
    layDownTddScaffold(projectDir);
    // Mutate one of the files so we can detect overwrites.
    const stateFile = join(projectDir, ".tdd", "workflow-state.json");
    writeFileSync(stateFile, JSON.stringify({ phase: "implementation", started_at: new Date().toISOString() }));
    layDownTddScaffold(projectDir);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.phase).toBe("implementation");
  });

  it("ships the feature/experiment/spike/synthesis/cycles subtree skeleton", () => {
    layDownTddScaffold(projectDir);
    for (const sub of ["features", "experiments", "spikes", "synthesis", "cycles"]) {
      expect(existsSync(join(projectDir, ".tdd", sub))).toBe(true);
    }
  });

  it("spec.md ships the feature catalog table header", () => {
    layDownTddScaffold(projectDir);
    const spec = readFileSync(join(projectDir, ".tdd", "spec.md"), "utf8");
    expect(spec).toMatch(/\| Feature \|/);
  });
});
