// Lakebase branch endpoint discovery.
//
// Reads endpoint metadata (host + state) for a branch. Does NOT mint
// credentials – that stays in get-connection.ts (single seam, CI-enforced).
// Composes with branch-utils.resolveBranchPath so callers can pass uid,
// sanitized name, or full resource path.

import { execFileSync } from "node:child_process";
import { resolveBranchId, resolveBranchPath } from "./branch-utils.js";
import { mintCredential } from "./get-connection.js";
import { DEFAULT_ENDPOINT } from "./constants.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

export interface EndpointInfo {
  host: string;
  state: string;
}

export interface GetEndpointArgs {
  instance: string;
  branch: string;
  /** Default: "primary" */
  endpointName?: string;
}

/**
 * Look up the primary endpoint for a Lakebase branch.
 *
 * Returns undefined when the branch has no endpoints yet, or when the
 * endpoint exists but has no host (still provisioning). For "wait until
 * ready" semantics, poll with a retry loop in the caller.
 */
export async function getEndpoint(args: GetEndpointArgs): Promise<EndpointInfo | undefined> {
  const branchPath = await resolveBranchPath(args.branch, { instance: args.instance });
  if (!branchPath) {
    return undefined;
  }
  let raw: string;
  try {
    raw = execFileSync("databricks", ["postgres", "list-endpoints", branchPath, "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: KIT_TIMEOUTS.cliDefault,
    });
  } catch {
    return undefined;
  }
  let endpoints: Array<{ status?: { hosts?: { host?: string }; current_state?: string } }>;
  try {
    endpoints = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return undefined;
  }
  const ep = endpoints[0];
  return {
    host: ep?.status?.hosts?.host ?? "",
    state: ep?.status?.current_state ?? "UNKNOWN",
  };
}

/**
 * Build the canonical endpoint resource path that mintCredential expects.
 * Convenience helper – most callers go through getConnection() which builds
 * this internally.
 *
 * **NOTE:** synchronous; does NOT normalize uid → branch_id. Caller is
 * responsible for passing `branch_id` (the friendly leaf, e.g.
 * "demo-feature" / "staging" / "production"). If you might be holding a
 * uid, await {@link resolveBranchId} from `./branch-utils.js` first.
 * The async helpers in this file (getEndpoint, ensureEndpoint, getCredential)
 * normalize for you.
 */
export function endpointPath(instance: string, branch: string, endpointName: string = DEFAULT_ENDPOINT): string {
  return `projects/${instance}/branches/${branch}/endpoints/${endpointName}`;
}

export interface EnsureEndpointArgs {
  instance: string;
  branch: string;
  /** Default: "primary" */
  endpointName?: string;
  /** Default: "ENDPOINT_TYPE_READ_WRITE" */
  endpointType?: "ENDPOINT_TYPE_READ_WRITE" | "ENDPOINT_TYPE_READ_ONLY";
  /** Autoscaling minimum compute units. Default: 2. */
  autoscalingMinCu?: number;
  /** Autoscaling maximum compute units. Default: 4. */
  autoscalingMaxCu?: number;
  /** Default: 120_000. Wait budget for the endpoint to reach ACTIVE state. */
  timeoutMs?: number;
}

/**
 * Get the primary endpoint for a branch, creating one if it doesn't exist.
 *
 * Mirrors the `get_or_create_endpoint` helper in templates/.../post-checkout.sh.
 * Used by `checkoutPaired` to make sure a freshly-resolved Lakebase branch
 * has a reachable endpoint before .env gets rewritten with credentials.
 */
export async function ensureEndpoint(args: EnsureEndpointArgs): Promise<EndpointInfo> {
  const endpointName = args.endpointName ?? DEFAULT_ENDPOINT;
  // Normalize once. Below, branchId flows into both the create-endpoint CLI
  // path and the retry/poll getEndpoint calls.
  const branchId = await resolveBranchId({ instance: args.instance, branch: args.branch });
  const existing = await getEndpoint({ instance: args.instance, branch: branchId, endpointName });
  if (existing?.host) {
    return existing;
  }

  const branchPath = `projects/${args.instance}/branches/${branchId}`;
  const spec = {
    spec: {
      endpoint_type: args.endpointType ?? "ENDPOINT_TYPE_READ_WRITE",
      autoscaling_limit_min_cu: args.autoscalingMinCu ?? 2,
      autoscaling_limit_max_cu: args.autoscalingMaxCu ?? 4,
    },
  };

  // Create endpoint (CLI may return immediately or block until ACTIVE)
  try {
    execFileSync(
      "databricks",
      ["postgres", "create-endpoint", branchPath, endpointName, "--json", JSON.stringify(spec)],
      { stdio: ["ignore", "pipe", "pipe"], timeout: KIT_TIMEOUTS.cliCreateEndpoint }
    );
  } catch (err) {
    // Race: the endpoint may have been created between our getEndpoint check
    // and the create call. Re-check before failing.
    const racy = await getEndpoint({ instance: args.instance, branch: branchId, endpointName });
    if (racy?.host) return racy;
    throw err;
  }

  // Poll until the endpoint reports an actual host
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.readyWait;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ep = await getEndpoint({ instance: args.instance, branch: branchId, endpointName });
    if (ep?.host) return ep;
    await new Promise((r) => setTimeout(r, KIT_TIMEOUTS.readyPoll));
  }
  throw new Error(
    `Endpoint for ${branchPath} did not reach ACTIVE within ${timeoutMs}ms (create succeeded but no host yet)`
  );
}

export interface GetCredentialArgs {
  instance: string;
  branch: string;
  /** Default: "primary" */
  endpointName?: string;
}

/**
 * Mint a short-lived `{ token, email }` for a branch's endpoint. Resolves the
 * branch path (so caller can pass uid / sanitized name / full path), then
 * routes through `mintCredential` in get-connection.ts – the single credential
 * seam. Useful for callers that want raw credentials rather than a DSN/Pool
 * (e.g. constructing a pg.Client with custom timeouts).
 */
export async function getCredential(args: GetCredentialArgs): Promise<{ token: string; email: string }> {
  const branchPath = await resolveBranchPath(args.branch, { instance: args.instance });
  if (!branchPath) {
    throw new Error(`Branch "${args.branch}" not found in instance "${args.instance}"`);
  }
  const endpointName = args.endpointName ?? DEFAULT_ENDPOINT;
  return mintCredential(`${branchPath}/endpoints/${endpointName}`);
}
