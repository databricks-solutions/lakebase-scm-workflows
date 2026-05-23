// BDD equivalence harness for lakebase-scm-workflows.
//
// Every workflow operation must produce identical on-disk / Lakebase / git
// state whether invoked through the extension call site or the agent call
// site. This harness exposes the three helpers tests use to assert that:
//
//   runViaExtension(op, args) — invoke the op the way the VS Code extension does
//   runViaAgent(op, args)     — invoke the op the way an agent does (node scripts/lakebase/<op>.js)
//   assertEquivalent(a, b)    — compare the two outcomes (on-disk diff, git state, Lakebase state)
//
// Implementations are deliberately thin until the first operation lands.
// Each `extract_*` JIRA sub-task (FEIP-7062..7064) extends these helpers
// with op-specific assertions.

export type OpResult = {
  /** Op name (e.g., "create-project") */
  op: string;
  /** stdout returned by the op (JSON when present) */
  stdout: string;
  /** Process exit code */
  exitCode: number;
  /** Files touched on disk, relative to the working tree (sorted) */
  filesTouched: string[];
  /** Git ref state at completion (branch -> HEAD sha) */
  gitState: Record<string, string>;
  /** Lakebase state snapshot at completion (instance/branch -> schema fingerprint) */
  lakebaseState: Record<string, string>;
};

export async function runViaExtension(_op: string, _args: Record<string, unknown>): Promise<OpResult> {
  throw new Error(
    "runViaExtension not implemented yet. Wire to extension service classes once they re-route to scripts (FEIP-7062 onward)."
  );
}

export async function runViaAgent(_op: string, _args: Record<string, unknown>): Promise<OpResult> {
  throw new Error(
    "runViaAgent not implemented yet. Wire to node scripts/lakebase/<op>.js once the first script lands (FEIP-7062 create-project)."
  );
}

export function assertEquivalent(a: OpResult, b: OpResult): void {
  if (a.op !== b.op) {
    throw new Error(`Op mismatch: ${a.op} vs ${b.op}`);
  }
  if (a.exitCode !== b.exitCode) {
    throw new Error(`Exit code mismatch on ${a.op}: extension=${a.exitCode} agent=${b.exitCode}`);
  }
  // Files touched should be identical sets (order ignored — caller pre-sorts)
  const filesA = a.filesTouched.join("\n");
  const filesB = b.filesTouched.join("\n");
  if (filesA !== filesB) {
    throw new Error(`Files touched mismatch on ${a.op}:\nextension:\n${filesA}\nagent:\n${filesB}`);
  }
  // Git refs
  const gitDiff = diffMaps(a.gitState, b.gitState);
  if (gitDiff) {
    throw new Error(`Git state mismatch on ${a.op}: ${gitDiff}`);
  }
  // Lakebase state
  const lakebaseDiff = diffMaps(a.lakebaseState, b.lakebaseState);
  if (lakebaseDiff) {
    throw new Error(`Lakebase state mismatch on ${a.op}: ${lakebaseDiff}`);
  }
}

function diffMaps(a: Record<string, string>, b: Record<string, string>): string | null {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) {
      return `key "${k}": extension=${a[k] ?? "<missing>"} agent=${b[k] ?? "<missing>"}`;
    }
  }
  return null;
}
