#!/usr/bin/env node
// FEIP-7143: install-time fetch of the devhub-published agent skills.
//
// Replaces the prior `scripts/sync-devhub-skills.sh` which both
// (a) hardcoded `databricks/devhub@main` (no pin -> silent drift) and
// (b) committed the fetched files into git under `skills/databricks-*/`.
//
// This script:
//   * reads `devhub.lock` for the pinned commit + the file list
//   * fetches each file via octokit (the same auth path the rest of
//     substrate uses, resolveGitHubToken)
//   * writes them to `skills/<skill>/<file>`, replacing whatever was
//     there
//
// The on-disk `skills/databricks-core/` and `skills/databricks-lakebase/`
// directories are now gitignored; this script is what populates them.
//
// Invocations:
//   tsx scripts/sync-devhub-skills.ts          # fetch (default)
//   tsx scripts/sync-devhub-skills.ts --check  # compare on-disk vs devhub@pin, exit 1 on drift
//
// `--check` is the building block FEIP-7144 (drift detector) will use
// to know when devhub HEAD has advanced past the pin.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "octokit";
import { resolveGitHubToken } from "./github/auth.js";

export interface DevhubLock {
  repo: string;
  ref: string;
  skills: Record<string, string[]>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LOCK_PATH = path.join(REPO_ROOT, "devhub.lock");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");

export function readLock(lockPath: string = LOCK_PATH): DevhubLock {
  const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<DevhubLock>;
  if (!raw.repo || !raw.ref || !raw.skills) {
    throw new Error(
      `devhub.lock is missing required fields {repo, ref, skills}: ${JSON.stringify(raw)}`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(raw.ref)) {
    throw new Error(
      `devhub.lock 'ref' must be a 40-char commit SHA (got "${raw.ref}"). Branch names are not allowed because install-time fetches must be reproducible.`,
    );
  }
  return raw as DevhubLock;
}

async function fetchFile(
  octokit: Octokit,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const [owner, name] = repo.split("/");
  const res = await octokit.rest.repos.getContent({
    owner,
    repo: name,
    path: filePath,
    ref,
  });
  const data = res.data as { type?: string; content?: string; encoding?: string };
  if (data.type !== "file" || typeof data.content !== "string") {
    throw new Error(`Expected file at ${repo}@${ref}:${filePath}, got ${data.type}`);
  }
  return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8");
}

async function syncOrCheck(mode: "sync" | "check"): Promise<void> {
  const lock = readLock();
  const token = await resolveGitHubToken();
  const octokit = new Octokit({ auth: token });

  const drift: string[] = [];

  for (const [skill, files] of Object.entries(lock.skills)) {
    for (const file of files) {
      const remotePath = `.agents/skills/${skill}/${file}`;
      const localPath = path.join(SKILLS_DIR, skill, file);
      process.stdout.write(`  ${skill}/${file} ... `);

      const remote = await fetchFile(octokit, lock.repo, lock.ref, remotePath);

      if (mode === "check") {
        const local = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
        if (local !== remote) {
          drift.push(`${skill}/${file}`);
          console.log("DRIFT");
        } else {
          console.log("ok");
        }
        continue;
      }

      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, remote);
      console.log("ok");
    }
  }

  if (mode === "check" && drift.length > 0) {
    process.stderr.write(`\nDrift detected on ${drift.length} file(s):\n`);
    for (const d of drift) process.stderr.write(`  ${d}\n`);
    process.stderr.write(
      `\nOn-disk content does not match ${lock.repo}@${lock.ref}. Run \`tsx scripts/sync-devhub-skills.ts\` to re-fetch, then review the diff before committing devhub.lock changes.\n`,
    );
    process.exit(1);
  }
}

// Only run the sync when invoked directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const mode = process.argv.includes("--check") ? "check" : "sync";
  const lock = readLock();
  console.log(`devhub-skills ${mode}: ${lock.repo}@${lock.ref}`);
  await syncOrCheck(mode);
  console.log("done.");
}
