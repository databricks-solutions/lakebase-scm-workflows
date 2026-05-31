// deploy-targets.yaml parser + writer for the lakebase-apps-deploy domain.
//
// A scaffolded Lakebase-paired project ships with a `deploy-targets.yaml`
// at its root. Each target describes one deployment destination (workspace
// profile, app name, Lakebase project/branch, optional UC + secret config).
//
// The substrate consumes the config in three places:
//   1. `lakebase-deploy` (FEIP-7130 slice 2) — picks the active target and
//      drives the build → upload → deploy pipeline.
//   2. `provisionAppEndpoint` (FEIP-7130 slice 3) — uses lakebase_project /
//      lakebase_branch to mint the per-branch app URL.
//   3. The lakebase-scm-extension consumes the same parser via the kit's
//      package exports, after the slice 6 import flip.
//
// The parser deliberately doesn't depend on a full YAML library: the file
// has a fixed two-level structure (targets → name → key: value), and a
// regex-based parser keeps the kit's dependency surface small. The same
// parser is what the lakebase-scm-extension shipped with originally; this
// module lifts it into the substrate behind a clean, kit-idiomatic surface.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface DeployTarget {
  workspace_profile: string;
  workspace_path: string;
  app_name: string;
  lakebase_project: string;
  lakebase_branch: string;
  uc_catalog?: string;
  uc_schema?: string;
  uc_volume?: string;
  lakebase_secret_scope?: string;
  lakebase_secret_key?: string;
  ai_model?: string;
}

export interface DeployTargetsConfig {
  targets: Record<string, DeployTarget>;
}

const TARGETS_FILE = "deploy-targets.yaml";

const OPTIONAL_KEYS: Array<keyof DeployTarget> = [
  "uc_catalog",
  "uc_schema",
  "uc_volume",
  "lakebase_secret_scope",
  "lakebase_secret_key",
  "ai_model",
];

export function readTargets(workspaceRoot: string): DeployTargetsConfig | null {
  const targetsFile = join(workspaceRoot, TARGETS_FILE);
  if (!existsSync(targetsFile)) return null;
  return parseTargetsYaml(readFileSync(targetsFile, "utf-8"));
}

export function writeTargets(config: DeployTargetsConfig, workspaceRoot: string): void {
  const targetsFile = join(workspaceRoot, TARGETS_FILE);
  let yaml = "targets:\n";
  for (const [name, target] of Object.entries(config.targets)) {
    yaml += `  ${name}:\n`;
    yaml += `    workspace_profile: ${target.workspace_profile}\n`;
    yaml += `    workspace_path: ${target.workspace_path}\n`;
    yaml += `    app_name: ${target.app_name}\n`;
    yaml += `    lakebase_project: ${target.lakebase_project}\n`;
    yaml += `    lakebase_branch: ${target.lakebase_branch}\n`;
    for (const key of OPTIONAL_KEYS) {
      const v = target[key];
      if (v) yaml += `    ${key}: ${v}\n`;
    }
  }
  writeFileSync(targetsFile, yaml);
}

export function parseTargetsYaml(content: string): DeployTargetsConfig {
  const targets: Record<string, DeployTarget> = {};
  let currentTarget: string | null = null;

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trimEnd();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === "targets:") continue;

    // Target name (2-space indent, ends with colon, no value).
    const targetMatch = trimmed.match(/^ {2}(\S+):$/);
    if (targetMatch) {
      currentTarget = targetMatch[1];
      targets[currentTarget] = {} as DeployTarget;
      continue;
    }

    // Key-value pair (4-space indent). Tolerates optional quoting on value.
    const kvMatch = trimmed.match(/^ {4}(\S+):\s*"?([^"]*)"?\s*$/);
    if (kvMatch && currentTarget) {
      const key = kvMatch[1];
      (targets[currentTarget] as unknown as Record<string, string>)[key] = kvMatch[2];
    }
  }

  return { targets };
}

export function getTargetNames(workspaceRoot: string): string[] {
  const config = readTargets(workspaceRoot);
  if (!config?.targets) return [];
  return Object.keys(config.targets);
}
