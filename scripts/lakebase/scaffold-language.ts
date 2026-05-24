// Language-specific scaffold router. Mirrors ScaffoldService.deployLanguageProject:
//   - java / kotlin   → Spring Initializr (with bundled fallback)
//   - python / nodejs → static template copy with {{PROJECT_NAME}} substitution

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirSubstituted } from "../util/copy-dir-substituted.js";
import {
  deploySpringStarter,
  SpringJvmLanguage,
  SpringInitializrClient,
  ScaffoldReportFn,
} from "./spring-initializr.js";

export type ProjectLanguage = "java" | "kotlin" | "python" | "nodejs";

export interface DeployLanguageProjectArgs {
  targetDir: string;
  language: ProjectLanguage;
  projectName?: string;
  /** Override templates dir (tests). */
  templatesDir?: string;
  /** Override Initializr client (tests). */
  initializrClient?: SpringInitializrClient;
  report?: ScaffoldReportFn;
}

let cachedTemplatesDir: string | undefined;
function findTemplatesDir(): string {
  if (cachedTemplatesDir) return cachedTemplatesDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "templates", "project");
    if (fs.existsSync(path.join(candidate, "common", ".gitignore.base"))) {
      cachedTemplatesDir = candidate;
      return cachedTemplatesDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate templates/project tree");
}

export async function deployLanguageProject(args: DeployLanguageProjectArgs): Promise<void> {
  if (args.language === "java" || args.language === "kotlin") {
    await deploySpringStarter({
      targetDir: args.targetDir,
      language: args.language as SpringJvmLanguage,
      projectName: args.projectName,
      templatesDir: args.templatesDir,
      initializrClient: args.initializrClient,
      report: args.report,
    });
    return;
  }

  // Python / Node.js — static template copy with placeholder substitution.
  const templatesDir = args.templatesDir ?? findTemplatesDir();
  const langSrc = path.join(templatesDir, args.language);
  if (!fs.existsSync(langSrc)) {
    throw new Error(`No template found for language: ${args.language}`);
  }
  copyDirSubstituted(langSrc, args.targetDir, { projectName: args.projectName });
}
