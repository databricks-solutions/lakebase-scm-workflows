// Per-file source upload to a Databricks Workspace path.
//
// `databricks apps deploy <name> --source-code-path <wsPath>` requires
// the source code to already be present at `wsPath` in the workspace.
// The bundle's `workspace import-dir` is unreliable for in-place updates
// (the extension's experience: it does not consistently overwrite Python
// files in particular). The substrate mirrors the extension's safer
// per-file pattern: walk the local directory, `mkdirs` each remote
// subdir, then `workspace import <remote-path> --file <local> --format
// AUTO --overwrite` each file.
//
// Used by `ensureAppEndpoint` (slice 3) to upload before deploy; also
// exported standalone for callers that want to manage the upload
// step independently.

import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { exec } from "../util/exec.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

export interface UploadDirectoryArgs {
  /** Local directory to upload. */
  localRoot: string;
  /** Workspace path destination (must be absolute, e.g.
   *  `/Workspace/Users/me/myapp`). Created if absent. */
  workspacePath: string;
  /** Databricks CLI profile. */
  profile: string;
  /** Subdirectory names to skip (default: `node_modules`, `.git`,
   *  `dist`, `.tmp`, `.vitest`, `.venv-live-tests`, `.tools-live-tests`,
   *  `coverage`, and any dotfile-prefixed dir). */
  skipDirs?: string[];
  /** Override per-import timeout. Default: KIT_TIMEOUTS.cliDefault. */
  timeoutMs?: number;
}

export interface UploadDirectoryResult {
  /** Number of files uploaded. */
  filesUploaded: number;
  /** Number of remote directories created. */
  dirsCreated: number;
  /** Per-file errors (non-fatal); the upload continues past failures so
   *  the caller can decide whether to retry or fail the deploy. */
  errors: Array<{ relPath: string; error: string }>;
}

const DEFAULT_SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  ".tmp",
  ".vitest",
  ".venv-live-tests",
  ".tools-live-tests",
  ".venv",
  "coverage",
];

/**
 * Recursively upload `localRoot` to `workspacePath` in the workspace.
 *
 * The remote root is created first (idempotent `workspace mkdirs`).
 * Each file is uploaded via `workspace import <remote> --file <local>
 * --format AUTO --overwrite`, which the platform treats as create-or-
 * replace. Parent directories are created on-demand as files are
 * walked; each `mkdirs` call is deduped via the in-memory createdDirs
 * set so a deep tree only hits the CLI once per directory.
 *
 * The walk skips well-known noise directories (node_modules, .git,
 * dist, ...). Override via `skipDirs`. Hidden files (leading dot) are
 * uploaded, since some are deploy-critical (e.g. `.env.example`).
 */
export async function uploadDirectory(args: UploadDirectoryArgs): Promise<UploadDirectoryResult> {
  const skipSet = new Set(args.skipDirs ?? DEFAULT_SKIP_DIRS);
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.cliDefault;
  const createdDirs = new Set<string>();
  const errors: UploadDirectoryResult["errors"] = [];
  let filesUploaded = 0;

  const escape = (s: string) => s.replace(/"/g, '\\"');

  const ensureRemoteDir = async (remoteDir: string) => {
    if (createdDirs.has(remoteDir)) return;
    await exec(
      `databricks workspace mkdirs "${escape(remoteDir)}" --profile "${escape(args.profile)}"`,
      { timeout: timeoutMs }
    );
    createdDirs.add(remoteDir);
  };

  await ensureRemoteDir(args.workspacePath);

  const uploadFile = async (localFile: string, relPath: string) => {
    // Force forward slashes in the workspace path (workspace paths are
    // POSIX-style on all platforms; sep is OS-dependent locally).
    const remotePath = `${args.workspacePath}/${relPath.split(sep).join("/")}`;
    const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
    if (remoteDir !== args.workspacePath) {
      await ensureRemoteDir(remoteDir);
    }
    try {
      await exec(
        `databricks workspace import "${escape(remotePath)}" --file "${escape(localFile)}" --format AUTO --overwrite --profile "${escape(args.profile)}"`,
        { timeout: timeoutMs }
      );
      filesUploaded++;
    } catch (err) {
      errors.push({ relPath, error: (err as Error).message });
    }
  };

  const walk = async (dirAbs: string, dirRel: string) => {
    for (const entry of readdirSync(dirAbs)) {
      const childAbs = join(dirAbs, entry);
      const childRel = dirRel ? `${dirRel}${sep}${entry}` : entry;
      const stat = statSync(childAbs);
      if (stat.isDirectory()) {
        if (skipSet.has(entry)) continue;
        await walk(childAbs, childRel);
      } else if (stat.isFile()) {
        await uploadFile(childAbs, childRel);
      }
      // Symlinks and special files are skipped.
    }
  };

  await walk(args.localRoot, "");

  return {
    filesUploaded,
    dirsCreated: createdDirs.size - 1, // subtract the root we always create
    errors,
  };
}

