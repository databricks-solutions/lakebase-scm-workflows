// Promise-wrapped child_process.exec. Ports src/utils/exec.ts from the
// extension. The script substrate uses this for git/databricks shell-outs;
// pure-API calls go through Octokit / @databricks/lakebase instead.

import * as cp from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds before SIGTERM. Default: 60_000. */
  timeout?: number;
}

export function exec(command: string, opts: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: cp.ExecOptions = {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 60_000,
    };
    if (opts.env) {
      options.env = { ...process.env, ...opts.env };
    }
    cp.exec(command, options, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        reject(new Error(`${command}: ${msg}`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}
