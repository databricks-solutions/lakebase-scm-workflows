// Service-principal + Lakebase credential propagation for a Databricks
// App deployment. Slice 5 of FEIP-7130.
//
// When a Databricks App is created, the platform auto-assigns it a
// dedicated service principal whose client_id surfaces via `apps get`.
// The bundle-deploy pattern (devhub Option A) would have the platform
// auto-grant SP access to declared resources, but Lakebase Postgres
// Projects are not a bundle resource type (per ADR-0002 amendment), so
// substrate grants the permission explicitly via the same path the
// extension uses: PATCH /api/2.0/permissions/database-projects/<name>.
//
// `propagateCredentials` is the single-seam orchestrator: pass a
// DeployTarget + profile + appName, it resolves the SP, grants the
// permission(s), returns a structured result.

import { exec } from "../util/exec.js";
import { KIT_TIMEOUTS } from "./kit-config.js";
import { DeployTarget } from "./deploy-targets.js";
import { getAppEndpoint } from "./deploy-app-endpoint.js";

export type LakebasePermissionLevel =
  | "CAN_USE"
  | "CAN_CREATE"
  | "CAN_MANAGE";

export interface GetAppServicePrincipalArgs {
  profile: string;
  appName: string;
  timeoutMs?: number;
}

export interface AppServicePrincipal {
  /** The SP's client_id (also called application_id). Used as the
   *  principal identifier in permissions API calls. */
  clientId: string;
  /** Optional human-readable name of the SP, when surfaced by `apps get`. */
  name?: string;
}

/**
 * Resolve the service principal that runs the given Databricks App.
 * Returns undefined when the app exists but does not yet have an SP
 * assigned (transitional state during app creation). Throws when the
 * app does not exist or the call fails.
 */
export async function getAppServicePrincipal(
  args: GetAppServicePrincipalArgs
): Promise<AppServicePrincipal | undefined> {
  const lookup = await getAppEndpoint({
    appName: args.appName,
    profile: args.profile,
    timeoutMs: args.timeoutMs,
  });
  if (!lookup.exists || !lookup.info) {
    throw new Error(`App "${args.appName}" not found on profile "${args.profile}"`);
  }
  // Apps API surfaces the SP client_id under either of these fields,
  // depending on CLI version. Surface as `clientId` for callers.
  const info = lookup.info;
  const clientId =
    (typeof info.service_principal_client_id === "string" && info.service_principal_client_id) ||
    (typeof info.service_principal_id === "string" && info.service_principal_id) ||
    "";
  if (!clientId) return undefined;
  const name = typeof info.service_principal_name === "string" ? info.service_principal_name : undefined;
  return { clientId, name };
}

export interface GrantLakebasePermissionArgs {
  profile: string;
  /** Lakebase project name (the bare name, e.g. `live-all-1780214536`). */
  projectName: string;
  /** Principal to grant. Pass an SP's clientId for app SPs; a user
   *  email for users; a group name for groups. */
  servicePrincipalName: string;
  /** Permission level to grant. Default: `CAN_MANAGE` (matches the
   *  extension's existing behavior; broader than strictly required to
   *  read/write but covers all kit workflows). */
  level?: LakebasePermissionLevel;
  /** Override the per-call timeout. Default: KIT_TIMEOUTS.cliDefault. */
  timeoutMs?: number;
}

export interface GrantLakebasePermissionResult {
  /** True iff the PATCH returned successfully. */
  granted: boolean;
}

/**
 * Grant a principal a permission level on a Lakebase Postgres project.
 *
 * Uses the `/api/2.0/permissions/database-projects/<name>` PATCH endpoint
 * (the kit's substrate is on the newer Lakebase Postgres API; that endpoint
 * still services this object type). Pass the project's bare name (not the
 * full `projects/<name>` resource path).
 *
 * Idempotent: re-running with the same args is a no-op at the API level
 * (the platform deduplicates ACL entries).
 */
export async function grantLakebasePermission(
  args: GrantLakebasePermissionArgs
): Promise<GrantLakebasePermissionResult> {
  const level = args.level ?? "CAN_MANAGE";
  const timeoutMs = args.timeoutMs ?? KIT_TIMEOUTS.cliDefault;
  const payload = JSON.stringify({
    access_control_list: [
      {
        service_principal_name: args.servicePrincipalName,
        permission_level: level,
      },
    ],
  });
  await exec(
    `databricks api patch "/api/2.0/permissions/database-projects/${escapeShellArg(args.projectName)}" --profile "${escapeShellArg(args.profile)}" --json '${escapeSingleQuoted(payload)}'`,
    { timeout: timeoutMs }
  );
  return { granted: true };
}

export interface PropagateCredentialsArgs {
  /** Target whose `lakebase_project` field names the project to grant. */
  target: DeployTarget;
  /** Databricks CLI profile. */
  profile: string;
  /** Name of the app whose service principal to grant. The app must
   *  already exist + have its SP assigned (ensureAppEndpoint blocks
   *  on ACTIVE state, so this holds after a successful ensure call). */
  appName: string;
  /** Lakebase permission level. Default: `CAN_MANAGE`. */
  level?: LakebasePermissionLevel;
  /** Override the per-call timeout. */
  timeoutMs?: number;
}

export interface PropagateCredentialsResult {
  /** SP client_id resolved from the app. Undefined when the app has
   *  no SP assigned yet (transitional). */
  servicePrincipalClientId: string | undefined;
  /** True iff the Lakebase permission was granted. False when the SP
   *  could not be resolved (the grant call was skipped). */
  lakebaseGranted: boolean;
}

/**
 * Single seam that resolves the app's service principal + grants it
 * access to the Lakebase project named in the target. Pairs with
 * `ensureAppEndpoint`: call ensure FIRST (it blocks on ACTIVE), then
 * propagateCredentials, then the app can connect to Lakebase via the
 * PG* env vars + the auto-generated credential (handled by
 * `@databricks/lakebase` at runtime).
 *
 * Returns `lakebaseGranted: false` (not a throw) when the SP cannot
 * be resolved; the caller decides whether to retry or fail the deploy.
 * Other failures (auth, network, permission API errors) propagate as
 * throws.
 */
export async function propagateCredentials(
  args: PropagateCredentialsArgs
): Promise<PropagateCredentialsResult> {
  const sp = await getAppServicePrincipal({
    appName: args.appName,
    profile: args.profile,
    timeoutMs: args.timeoutMs,
  });
  if (!sp) {
    return { servicePrincipalClientId: undefined, lakebaseGranted: false };
  }
  await grantLakebasePermission({
    profile: args.profile,
    projectName: args.target.lakebase_project,
    servicePrincipalName: sp.clientId,
    level: args.level,
    timeoutMs: args.timeoutMs,
  });
  return {
    servicePrincipalClientId: sp.clientId,
    lakebaseGranted: true,
  };
}

// ─── helpers ────────────────────────────────────────────────────

function escapeShellArg(s: string): string {
  return s.replace(/"/g, '\\"');
}

function escapeSingleQuoted(s: string): string {
  // Within single-quoted shell strings, the only escape needed is to
  // close + reopen for embedded apostrophes. The JSON payload itself
  // contains no apostrophes, but harden anyway for future-proofing.
  return s.replace(/'/g, `'\\''`);
}
