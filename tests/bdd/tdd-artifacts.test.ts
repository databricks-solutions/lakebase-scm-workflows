import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeArtifact,
  listArtifacts,
  readArtifact,
} from "../../scripts/tdd/artifacts";

let tdd: string;
const FEATURE_ID = "F1-checkout";
const EXP = "exp-postgres-arrays";

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-artifacts-"));
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("artifact persistence", () => {
  it("writeArtifact creates the cycle dir on demand and returns the absolute path", () => {
    const path = writeArtifact({
      tddDir: tdd,
      featureId: FEATURE_ID,
      experimentSlug: EXP,
      cycleId: "C1",
      name: "vitest.junit.xml",
      content: "<testsuites />",
    });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("<testsuites />");
    expect(path.endsWith("artifacts/C1/vitest.junit.xml")).toBe(true);
  });

  it("writeArtifact accepts nested name paths (creates intermediate dirs)", () => {
    const path = writeArtifact({
      tddDir: tdd,
      featureId: FEATURE_ID,
      experimentSlug: EXP,
      cycleId: "C1",
      name: "traces/network/spec-1.har",
      content: Buffer.from([0x00, 0x01, 0x02]),
    });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(Buffer.from([0x00, 0x01, 0x02]));
  });

  it("writeArtifact rejects path-traversal names", () => {
    expect(() =>
      writeArtifact({
        tddDir: tdd,
        featureId: FEATURE_ID,
        experimentSlug: EXP,
        cycleId: "C1",
        name: "../../escape.txt",
        content: "x",
      })
    ).toThrow(/invalid name/);
  });

  it("writeArtifact rejects absolute paths", () => {
    expect(() =>
      writeArtifact({
        tddDir: tdd,
        featureId: FEATURE_ID,
        experimentSlug: EXP,
        cycleId: "C1",
        name: "/etc/passwd",
        content: "x",
      })
    ).toThrow(/invalid name/);
  });

  it("listArtifacts scoped to a cycle returns just that cycle's files (sorted)", () => {
    writeArtifact({ tddDir: tdd, featureId: FEATURE_ID, experimentSlug: EXP, cycleId: "C1", name: "b.log", content: "" });
    writeArtifact({ tddDir: tdd, featureId: FEATURE_ID, experimentSlug: EXP, cycleId: "C1", name: "a.log", content: "" });
    writeArtifact({ tddDir: tdd, featureId: FEATURE_ID, experimentSlug: EXP, cycleId: "C2", name: "z.log", content: "" });
    const c1 = listArtifacts(tdd, FEATURE_ID, EXP, "C1");
    expect(c1.map((e) => e.name)).toEqual(["a.log", "b.log"]);
    expect(c1.every((e) => e.cycle_id === "C1")).toBe(true);
  });

  it("listArtifacts without cycleId enumerates across all cycles", () => {
    writeArtifact({ tddDir: tdd, featureId: FEATURE_ID, experimentSlug: EXP, cycleId: "C1", name: "a.log", content: "" });
    writeArtifact({ tddDir: tdd, featureId: FEATURE_ID, experimentSlug: EXP, cycleId: "C2", name: "a.log", content: "" });
    const all = listArtifacts(tdd, FEATURE_ID, EXP);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.cycle_id))).toEqual(new Set(["C1", "C2"]));
  });

  it("listArtifacts returns empty when the experiment has no artifacts dir yet", () => {
    expect(listArtifacts(tdd, FEATURE_ID, EXP)).toEqual([]);
    expect(listArtifacts(tdd, FEATURE_ID, EXP, "C-missing")).toEqual([]);
  });

  it("each ArtifactEntry has the documented shape (name, path, cycle_id, size, modified)", () => {
    writeArtifact({
      tddDir: tdd,
      featureId: FEATURE_ID,
      experimentSlug: EXP,
      cycleId: "C1",
      name: "report.json",
      content: '{"ok":true}',
    });
    const [entry] = listArtifacts(tdd, FEATURE_ID, EXP, "C1");
    expect(Object.keys(entry).sort()).toEqual(["cycle_id", "modified", "name", "path", "size"].sort());
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("readArtifact round-trips bytes written by writeArtifact", () => {
    const payload = Buffer.from("trace-blob", "utf8");
    writeArtifact({
      tddDir: tdd,
      featureId: FEATURE_ID,
      experimentSlug: EXP,
      cycleId: "C1",
      name: "trace.bin",
      content: payload,
    });
    const round = readArtifact({
      tddDir: tdd,
      featureId: FEATURE_ID,
      experimentSlug: EXP,
      cycleId: "C1",
      name: "trace.bin",
    });
    expect(round).toEqual(payload);
  });

  it("readArtifact returns null when the artifact does not exist", () => {
    const round = readArtifact({
      tddDir: tdd,
      featureId: FEATURE_ID,
      experimentSlug: EXP,
      cycleId: "C1",
      name: "ghost.txt",
    });
    expect(round).toBeNull();
  });
});
