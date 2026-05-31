// Resolve the workspace host URL for a Databricks CLI profile.
//
// The CLI's older `databricks auth env --profile <p>` was deprecated in
// v1.1.0 in favor of `databricks auth describe --profile <p> -o json`.
// substrate's resolveDatabricksHost uses the new shape; consumers that
// previously shelled out to `auth env` should switch to this primitive
// to keep working on the upgraded CLI.
//
// Returns the host without trailing slash (e.g. `https://fevm-...cloud.databricks.com`).
// Returns undefined for unknown profiles or parse failures; throws only
// on infrastructure failures (CLI not on PATH, timeout). The CLI may
// prefix the JSON output with warning / auth-error lines (e.g. when the
// token cache is invalidated by a CLI upgrade); we tolerate that by
// trimming to the first `{` before parsing.

import { exec } from "../util/exec.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

export interface ResolveDatabricksHostArgs {
  /** Databricks CLI profile from ~/.databrickscfg. */
  profile: string;
  /** Override the per-call timeout. Default: KIT_TIMEOUTS.cliDefault. */
  timeoutMs?: number;
}

/**
 * Resolve the workspace host URL for the named profile via
 * `databricks auth describe -o json`. Returns the host string without
 * trailing slash, or undefined when the profile is unknown or the
 * response is unparseable.
 */
export async function resolveDatabricksHost(
  args: ResolveDatabricksHostArgs
): Promise<string | undefined> {
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.cliDefault;
  const out = await exec(
    `databricks auth describe --profile "${escapeShellArg(args.profile)}" -o json`,
    { timeout: timeoutMs }
  );
  return parseHostFromAuthDescribe(out);
}

/**
 * Exposed for unit testing. Trims a non-JSON preamble (some CLI
 * builds prefix a warning or auth-error line before the JSON payload),
 * parses the JSON, and extracts `details.host`.
 */
export function parseHostFromAuthDescribe(out: string): string | undefined {
  const start = out.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(out.slice(start)) as Record<string, unknown>;
    const details = parsed.details;
    if (!details || typeof details !== "object") return undefined;
    const host = (details as Record<string, unknown>).host;
    if (typeof host !== "string") return undefined;
    return host.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function escapeShellArg(s: string): string {
  return s.replace(/"/g, '\\"');
}
