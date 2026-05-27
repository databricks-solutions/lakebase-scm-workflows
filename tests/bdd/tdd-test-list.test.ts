import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readMasterTestList,
  writeMasterTestList,
  viewByAc,
  viewsForAllAcs,
  writePerAcViews,
  type TestList,
} from "../../scripts/tdd/test-list";

let tdd: string;
const FEATURE_DIR = "features/F1-test-feature";
const STORY_DIR = `${FEATURE_DIR}/stories/S1-test-story`;
const ACS_DIR = `${STORY_DIR}/acs`;

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "tdd-test-list-"));
  mkdirSync(join(tdd, ACS_DIR), { recursive: true });
  writeFileSync(join(tdd, ACS_DIR, "AC1.json"), JSON.stringify({ id: "AC1", layer: "API" }));
  writeFileSync(join(tdd, ACS_DIR, "AC2.json"), JSON.stringify({ id: "AC2", layer: "API" }));
});

afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

function masterList(): TestList {
  return {
    feature_id: "F1",
    ordered_for: "design-momentum",
    items: [
      { id: "T1", description: "force API shape", ac_id: "AC1", status: "pending" },
      { id: "T2", description: "happy path", ac_id: "AC1", status: "pending" },
      { id: "T3", description: "edge case", ac_id: "AC2", status: "pending" },
    ],
  };
}

describe("test-list", () => {
  it("writeMasterTestList then readMasterTestList round-trip", () => {
    const list = masterList();
    writeMasterTestList(tdd, list);
    expect(readMasterTestList(tdd, "F1")).toEqual(list);
  });

  it("viewByAc filters items to a single AC", () => {
    const list = masterList();
    const view = viewByAc(list, "AC1");
    expect(view.ac_id).toBe("AC1");
    expect(view.items.map((i) => i.id)).toEqual(["T1", "T2"]);
  });

  it("viewsForAllAcs partitions items by ac_id", () => {
    const list = masterList();
    const views = viewsForAllAcs(list);
    expect(Object.keys(views).sort()).toEqual(["AC1", "AC2"]);
    expect(views.AC1.items.length).toBe(2);
    expect(views.AC2.items.length).toBe(1);
  });

  it("writePerAcViews writes one file per story dir with views for each AC in that story", () => {
    const list = masterList();
    writeMasterTestList(tdd, list);
    const written = writePerAcViews(tdd, "F1", list);
    expect(written.length).toBeGreaterThan(0);

    const perAcFile = join(tdd, STORY_DIR, "test-list-per-ac.json");
    expect(existsSync(perAcFile)).toBe(true);
    const views = JSON.parse(readFileSync(perAcFile, "utf8"));
    expect(views.length).toBe(2);
    const ac1 = views.find((v: { ac_id: string }) => v.ac_id === "AC1");
    const ac2 = views.find((v: { ac_id: string }) => v.ac_id === "AC2");
    expect(ac1.items.length).toBe(2);
    expect(ac2.items.length).toBe(1);
  });

  it("writePerAcViews preserves existing entries when called repeatedly", () => {
    const list = masterList();
    writeMasterTestList(tdd, list);
    writePerAcViews(tdd, "F1", list);
    const second: TestList = {
      ...list,
      items: [{ id: "T1", description: "force API shape (updated)", ac_id: "AC1", status: "red" }],
    };
    writePerAcViews(tdd, "F1", second);
    const perAcFile = join(tdd, STORY_DIR, "test-list-per-ac.json");
    const views = JSON.parse(readFileSync(perAcFile, "utf8"));
    expect(views.length).toBe(2);
    const ac1 = views.find((v: { ac_id: string }) => v.ac_id === "AC1");
    expect(ac1.items[0].status).toBe("red");
  });
});
