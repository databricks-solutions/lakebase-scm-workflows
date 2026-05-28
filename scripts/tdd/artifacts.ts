// Per-cycle artifact persistence for TDD experiments.
//
// On-disk layout:
//
//   .tdd/experiments/<F>/<exp>/artifacts/<cycle-id>/<name>
//
// Where <name> may include subdirectories (e.g. "traces/network.har").
//
// The orchestrator writes here after every cycle (Playwright traces, vitest
// junit output, screenshots, repro scripts). The comparison-report renderer
// (FEIP-7208) reads listings via listArtifacts to surface what's available
// when the PO is deciding promote vs synthesize.
//
// Gitignored by default in scaffolded projects: artifacts can be large and
// rebuilding them from logs is cheap. The scaffold step that writes the
// project's .gitignore is owned by lakebase-create-project + slice 4 of
// FEIP-7092 (orchestration), not this module.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

export interface WriteArtifactArgs {
  tddDir: string;
  featureId: string;
  experimentSlug: string;
  cycleId: string;
  /**
   * Relative path within the cycle's artifacts dir. May include subdirs
   * (e.g. "traces/spec-1.zip"). Intermediate dirs are created on demand.
   */
  name: string;
  /** Content to write. Strings are written as UTF-8; Buffers as-is. */
  content: string | Buffer;
}

export interface ArtifactEntry {
  name: string;
  path: string;
  cycle_id: string;
  size: number;
  modified: string;
}

function artifactsRoot(tddDir: string, featureId: string, experimentSlug: string): string {
  return join(tddDir, "experiments", featureId, experimentSlug, "artifacts");
}

function cycleDir(args: { tddDir: string; featureId: string; experimentSlug: string; cycleId: string }): string {
  return join(artifactsRoot(args.tddDir, args.featureId, args.experimentSlug), args.cycleId);
}

export function writeArtifact(args: WriteArtifactArgs): string {
  if (!args.name || args.name.startsWith("/") || args.name.includes("..")) {
    throw new Error(`writeArtifact: invalid name '${args.name}'`);
  }
  const dest = join(cycleDir(args), args.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, args.content);
  return dest;
}

/**
 * List artifacts under an experiment. If cycleId is provided, scope to that
 * cycle; otherwise enumerate across all cycles. Returns entries with
 * cycle-relative names so consumers can stable-sort by (cycle_id, name).
 */
export function listArtifacts(
  tddDir: string,
  featureId: string,
  experimentSlug: string,
  cycleId?: string
): ArtifactEntry[] {
  const root = artifactsRoot(tddDir, featureId, experimentSlug);
  if (!existsSync(root)) return [];
  const entries: ArtifactEntry[] = [];
  const cycleIds = cycleId
    ? [cycleId].filter((c) => existsSync(join(root, c)))
    : readdirSync(root).filter((c) => statSync(join(root, c)).isDirectory());
  for (const c of cycleIds) {
    const cycleRoot = join(root, c);
    for (const relPath of walkFiles(cycleRoot)) {
      const abs = join(cycleRoot, relPath);
      const stat = statSync(abs);
      entries.push({
        name: relPath,
        path: abs,
        cycle_id: c,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  return entries;
}

export function readArtifact(args: {
  tddDir: string;
  featureId: string;
  experimentSlug: string;
  cycleId: string;
  name: string;
}): Buffer | null {
  const path = join(cycleDir(args), args.name);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string) {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) recurse(abs);
      else if (stat.isFile()) out.push(relative(root, abs));
    }
  }
  recurse(root);
  out.sort();
  return out;
}
