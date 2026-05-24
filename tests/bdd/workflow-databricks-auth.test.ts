import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

// REGRESSION GUARD: Databricks CLI v1.0+ refuses to read credentials from
// the v0.x file cache and won't silently fall back to DATABRICKS_TOKEN. On
// any runner with a pre-v1 ~/.databricks/ cache present (self-hosted Mac
// runners that pre-date the v1 cutover), `databricks current-user me`
// errors out before the PAT is consulted. The fix is `DATABRICKS_AUTH_TYPE: pat`
// in every env block that sets DATABRICKS_TOKEN — that pins auth to the PAT
// and bypasses the cache.
//
// This was discovered by python-devloop integration test: pr.yml's preflight
// `databricks current-user me >/dev/null 2>&1` failed silently (stderr was
// discarded), wrote write_skip with a misleading "Token may be expired"
// reason, and downstream Run tests fell over with no CI DB.
//
// Every workflow YAML template that uses DATABRICKS_TOKEN must also set
// DATABRICKS_AUTH_TYPE: pat in the same env block.

const WORKFLOWS_DIR = path.resolve(__dirname, "../../templates/project/common/.github/workflows");

interface Step {
  name?: string;
  env?: Record<string, unknown>;
  run?: string;
}

interface Job {
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
}

function loadWorkflow(file: string): Workflow {
  const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
  return yaml.load(content) as Workflow;
}

function walkSteps(wf: Workflow): { jobName: string; stepIdx: number; step: Step }[] {
  const out: { jobName: string; stepIdx: number; step: Step }[] = [];
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    for (let i = 0; i < (job.steps ?? []).length; i++) {
      out.push({ jobName, stepIdx: i, step: job.steps![i] });
    }
  }
  return out;
}

const WORKFLOW_FILES = ["pr.yml", "merge.yml", "cleanup-orphans.yml"];

describe("workflow templates — DATABRICKS_AUTH_TYPE pinned to pat", () => {
  for (const file of WORKFLOW_FILES) {
    it(`${file}: every env block with DATABRICKS_TOKEN also sets DATABRICKS_AUTH_TYPE: pat`, () => {
      const wf = loadWorkflow(file);
      const offenders: string[] = [];
      for (const { jobName, stepIdx, step } of walkSteps(wf)) {
        if (!step.env) continue;
        const hasToken = "DATABRICKS_TOKEN" in step.env;
        if (!hasToken) continue;
        const authType = step.env.DATABRICKS_AUTH_TYPE;
        if (authType !== "pat") {
          const stepLabel = step.name ?? `step[${stepIdx}]`;
          offenders.push(`  - ${jobName} / "${stepLabel}" — DATABRICKS_AUTH_TYPE=${JSON.stringify(authType ?? "<unset>")}`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(
          `${file}: env blocks set DATABRICKS_TOKEN without DATABRICKS_AUTH_TYPE: pat.\n` +
            `Databricks CLI v1+ won't fall back to DATABRICKS_TOKEN when a legacy ~/.databricks/ cache is present.\n` +
            `Add DATABRICKS_AUTH_TYPE: pat to:\n` +
            offenders.join("\n")
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe("workflow templates — preflight surfaces auth stderr", () => {
  // The original failure mode was `databricks current-user me >/dev/null 2>&1`
  // discarding the actual error string. Every preflight that calls
  // `databricks current-user me` must capture stderr so the run log shows
  // why auth failed instead of writing a generic "Token may be expired".
  for (const file of WORKFLOW_FILES) {
    it(`${file}: no run block uses 'databricks current-user me ... >/dev/null 2>&1'`, () => {
      const wf = loadWorkflow(file);
      const offenders: string[] = [];
      for (const { jobName, stepIdx, step } of walkSteps(wf)) {
        if (!step.run) continue;
        if (/databricks\s+current-user\s+me[^|&;]*>\s*\/dev\/null\s+2>&1/.test(step.run)) {
          const stepLabel = step.name ?? `step[${stepIdx}]`;
          offenders.push(`  - ${jobName} / "${stepLabel}"`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(
          `${file}: preflight discards stderr from 'databricks current-user me'.\n` +
            `Capture it instead (AUTH_ERR=...; if [ -n "$AUTH_ERR" ]; then ... fi) so the\n` +
            `real failure reason reaches the run log:\n` +
            offenders.join("\n")
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});
