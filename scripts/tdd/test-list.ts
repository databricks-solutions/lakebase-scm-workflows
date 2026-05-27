import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

export interface TestListItem {
  id: string;
  description: string;
  ac_id: string;
  status: "pending" | "red" | "green" | "refactored" | "skipped";
  scenario_file?: string;
  notes?: string;
}

export interface TestList {
  feature_id: string;
  ordered_for?: "design-momentum" | "risk-first" | "happy-path-first";
  items: TestListItem[];
}

export function readMasterTestList(tddDir: string, featureId: string): TestList {
  const dir = findFeatureDir(tddDir, featureId);
  const file = join(dir, "test-list.json");
  if (!existsSync(file)) {
    throw new Error(`master test-list.json not found for ${featureId} at ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeMasterTestList(tddDir: string, list: TestList): void {
  const dir = findFeatureDir(tddDir, list.feature_id);
  const file = join(dir, "test-list.json");
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
}

export interface PerAcView {
  ac_id: string;
  items: TestListItem[];
}

export function viewByAc(list: TestList, acId: string): PerAcView {
  return {
    ac_id: acId,
    items: list.items.filter((it) => it.ac_id === acId),
  };
}

export function viewsForAllAcs(list: TestList): Record<string, PerAcView> {
  const out: Record<string, PerAcView> = {};
  for (const item of list.items) {
    if (!out[item.ac_id]) out[item.ac_id] = { ac_id: item.ac_id, items: [] };
    out[item.ac_id].items.push(item);
  }
  return out;
}

export function writePerAcViews(tddDir: string, featureId: string, list: TestList): string[] {
  const featureDir = findFeatureDir(tddDir, featureId);
  const views = viewsForAllAcs(list);
  const written: string[] = [];
  for (const [acId, view] of Object.entries(views)) {
    const storyDir = locateStoryDirForAc(featureDir, acId);
    if (!storyDir) continue;
    const outFile = join(storyDir, "test-list-per-ac.json");
    let existing: PerAcView[] = [];
    if (existsSync(outFile)) {
      existing = JSON.parse(readFileSync(outFile, "utf8"));
    }
    const merged = mergeViews(existing, view);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(merged, null, 2) + "\n");
    written.push(outFile);
  }
  return written;
}

function mergeViews(existing: PerAcView[], next: PerAcView): PerAcView[] {
  const remaining = existing.filter((v) => v.ac_id !== next.ac_id);
  remaining.push(next);
  return remaining;
}

function locateStoryDirForAc(featureDir: string, acId: string): string | null {
  const storiesDir = join(featureDir, "stories");
  if (!existsSync(storiesDir)) return null;
  for (const storyDirName of readdirSync(storiesDir)) {
    const storyDir = join(storiesDir, storyDirName);
    if (!statSync(storyDir).isDirectory()) continue;
    const acsDir = join(storyDir, "acs");
    if (!existsSync(acsDir)) continue;
    const match = readdirSync(acsDir).find((f) => f.startsWith(acId) && f.endsWith(".json"));
    if (match) return storyDir;
  }
  return null;
}

function findFeatureDir(tddDir: string, featureId: string): string {
  const featuresDir = join(tddDir, "features");
  if (!existsSync(featuresDir)) {
    throw new Error(`${featuresDir} does not exist`);
  }
  const candidates = readdirSync(featuresDir).filter((d) => d.startsWith(featureId));
  if (candidates.length === 0) {
    throw new Error(`feature ${featureId} not found under ${featuresDir}`);
  }
  return join(featuresDir, candidates[0]);
}
