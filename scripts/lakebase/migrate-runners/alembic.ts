// Alembic runner for the kit's migrate primitives (FEIP-7091).
//
// Reference implementation. Shells out to `alembic`. Expects the project
// to have a working `alembic.ini` and a `migrations/versions/` (or
// `alembic/versions/`) directory.
//
// DATABASE_URL is the standard env hook Alembic projects read in their
// env.py via `os.getenv("DATABASE_URL")`. We export it scoped to the
// child process so we never mutate the caller's env.
//
// Result derivation is state-based, not log-based: we call `alembic
// current` before and after upgrade/downgrade and use `alembic history`
// to enumerate the revisions between those two pins. Alembic's own
// stdout/stderr is not load-bearing here, which keeps the runner robust
// to logger config drift in the consumer's `alembic.ini`.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MigrationError,
  type ApplyMigrationsResult,
  type RollbackMigrationResult,
  type MigrationStatusResult,
  type AppliedMigration,
  type PendingMigration,
} from "../migrate.js";

interface RunnerCtx {
  projectDir: string;
  dsn: string;
}

/**
 * Resolve the `alembic` binary path. uv-managed Python projects install
 * alembic into a per-project `.venv/bin/alembic`, which is NOT on the
 * runner's PATH. Spawning bare `alembic` fails with ENOENT in CI even
 * after `uv sync` succeeded. Prefer the project-local venv when it
 * exists; fall back to bare `alembic` for projects with a pre-activated
 * shell venv or a system-wide install.
 */
export function resolveAlembicBin(projectDir: string): string {
  const candidates = [
    path.join(projectDir, ".venv", "bin", "alembic"),
    path.join(projectDir, "venv", "bin", "alembic"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // best-effort; keep checking
    }
  }
  return "alembic";
}

function runAlembic(ctx: RunnerCtx, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const bin = resolveAlembicBin(ctx.projectDir);
    const child = spawn(bin, args, {
      cwd: ctx.projectDir,
      env: { ...process.env, DATABASE_URL: ctx.dsn },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new MigrationError(
          `Could not spawn alembic. Is it installed and on PATH? ${err.message}`,
          err
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new MigrationError(
            `alembic ${args.join(" ")} exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`
          )
        );
      }
    });
  });
}

/** Return the currently-applied head revision, or undefined when the DB has no Alembic state. */
async function getCurrentRevision(ctx: RunnerCtx): Promise<string | undefined> {
  const { stdout } = await runAlembic(ctx, ["current"]);
  const m = stdout.match(/^([a-f0-9]+)\b/m);
  return m ? m[1] : undefined;
}

/** Return the latest available revision in the local migrations directory. */
async function getHeadRevision(ctx: RunnerCtx): Promise<string | undefined> {
  const { stdout } = await runAlembic(ctx, ["heads"]);
  const m = stdout.match(/^([a-f0-9]+)\b/m);
  return m ? m[1] : undefined;
}

/**
 * Enumerate the revisions in `alembic history -r <range>`. Returns the
 * "->target, description" half of each line, newest-first as alembic
 * emits them.
 */
async function listHistory(ctx: RunnerCtx, range: string): Promise<AppliedMigration[]> {
  const { stdout } = await runAlembic(ctx, ["history", "-r", range]);
  const out: AppliedMigration[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(?:<base>|[a-f0-9]+)\s*->\s*([a-f0-9]+)(?:\s*\(head\))?,\s*(.*)$/);
    if (m) out.push({ version: m[1].trim(), description: m[2].trim() });
  }
  return out;
}

export async function applyAlembic(ctx: RunnerCtx): Promise<ApplyMigrationsResult> {
  const before = await getCurrentRevision(ctx);
  await runAlembic(ctx, ["upgrade", "head"]);
  const after = await getCurrentRevision(ctx);

  if (!after || before === after) {
    return { applied: [], alreadyAtLatest: true, tool: "alembic" };
  }

  // Range is inclusive on both ends. When `before` is undefined we walk
  // base..after and keep everything; otherwise we drop `before` itself
  // (it was already applied prior to this call).
  const range = before ? `${before}:${after}` : `base:${after}`;
  const inRange = await listHistory(ctx, range);
  const applied = before ? inRange.filter((a) => a.version !== before) : inRange;

  return { applied, alreadyAtLatest: false, tool: "alembic" };
}

export async function rollbackAlembic(
  ctx: RunnerCtx & { target: string }
): Promise<RollbackMigrationResult> {
  const before = await getCurrentRevision(ctx);
  if (!before) {
    // Nothing applied; nothing to roll back.
    await runAlembic(ctx, ["downgrade", ctx.target]);
    return { rolledBack: [], tool: "alembic" };
  }
  await runAlembic(ctx, ["downgrade", ctx.target]);
  const after = await getCurrentRevision(ctx);

  // What was rolled back: revisions reachable from `before` down to (but
  // not including) `after`. When `after` is undefined we walked all the
  // way back to base, so every revision in `base:before` was rolled back.
  const range = after ? `${after}:${before}` : `base:${before}`;
  const inRange = await listHistory(ctx, range);
  const rolledBack = after ? inRange.filter((a) => a.version !== after) : inRange;

  return { rolledBack, tool: "alembic" };
}

export async function statusAlembic(ctx: RunnerCtx): Promise<MigrationStatusResult> {
  const current = await getCurrentRevision(ctx);
  const head = await getHeadRevision(ctx);

  const pending: PendingMigration[] = [];
  if (head && head !== current) {
    const range = current ? `${current}:head` : `base:head`;
    const inRange = await listHistory(ctx, range);
    for (const rev of inRange) {
      if (current && rev.version === current) continue;
      pending.push({
        version: rev.version,
        filename: `${rev.version}_*.py`,
        description: rev.description,
      });
    }
  }

  return { current, pending, tool: "alembic" };
}
