// Branded identifier types for Lakebase branches.
//
// A Lakebase branch has TWO distinct identifiers and they are NOT
// interchangeable in the API:
//
//   BranchName  – the human-readable leaf of the resource path
//                 (`production`, `staging`, `feature-add-orders`). Used in
//                 EVERY API field that takes a branch path or source_branch
//                 reference. The leaf of `projects/<id>/branches/<NAME>`.
//
//   BranchUid   – the system-assigned alphanumeric identifier
//                 (`br-crimson-fire-d28lb2ez`). Returned by `list-branches`
//                 as the `uid` field. Used only for direct uid lookups in
//                 the few flows that need them.
//
// The Lakebase API rejects a BranchUid in any path-shaped field with a
// confusing "branch id not found" error. To make that swap impossible at
// the type level (and to fail fast at runtime when an upstream returned
// the wrong identifier), these brands + their constructors are the single
// seam every branch-id-handling helper in the kit should funnel through.
//
// Pattern: strict internals, lenient boundaries. Internal substrate
// functions take `BranchName` / `BranchUid` directly so the compiler
// catches accidental swaps. Boundary functions that accept a string from
// the outside world (CLI bins, MCP tool handlers) validate via the
// constructors below and surface a typed error message that explains the
// distinction.

declare const BRAND: unique symbol;

/**
 * The leaf of a Lakebase branch resource path
 * (`projects/<id>/branches/<NAME>`). Use in source_branch fields, in
 * .env LAKEBASE_BRANCH_NAME, and anywhere a CLI subresource URL needs
 * `{branch}`. NEVER pass a BranchUid where a BranchName is expected.
 */
export type BranchName = string & { readonly [BRAND]: "BranchName" };

/**
 * The system-assigned Lakebase branch uid (`br-crimson-fire-d28lb2ez`).
 * Returned in the `uid` field of `list-branches` / `get-branch`. Used
 * only for direct uid lookups. NEVER paste into a path-shaped API field.
 */
export type BranchUid = string & { readonly [BRAND]: "BranchUid" };

const UID_PATTERN = /^br-[a-z0-9-]+$/;

/**
 * Structural check: does `s` match the BranchUid pattern (`br-…`)? Does
 * NOT prove the uid actually exists – just that the shape matches.
 */
export function looksLikeBranchUid(s: string): boolean {
  return UID_PATTERN.test(s);
}

/**
 * Wrap `s` as a BranchName, throwing if `s` looks like a BranchUid
 * (which is almost certainly a programmer error – the API will reject it
 * in path-shaped fields). Use at every kit boundary that receives a
 * branch identifier from outside.
 *
 * @throws TypeError when `s` is empty or matches the BranchUid pattern.
 */
export function asBranchName(s: string): BranchName {
  if (!s) throw new TypeError("BranchName cannot be empty");
  if (looksLikeBranchUid(s)) {
    throw new TypeError(
      `'${s}' looks like a BranchUid (br-… pattern), not a BranchName. ` +
        `BranchName is the resource-path leaf (e.g. 'production', 'staging', 'feature-add-orders'); ` +
        `BranchUid is the system identifier returned by list-branches as the 'uid' field. ` +
        `The Lakebase API rejects a BranchUid in any path-shaped field. If you really mean a ` +
        `BranchUid, use asBranchUid() instead – but verify you're calling a function that takes one.`
    );
  }
  return s as BranchName;
}

/**
 * Wrap `s` as a BranchUid, throwing if `s` does not match the `br-…`
 * pattern. Use only at the few places that genuinely need to pass a uid
 * (direct uid-based lookups).
 *
 * @throws TypeError when `s` is empty or does not match the BranchUid pattern.
 */
export function asBranchUid(s: string): BranchUid {
  if (!s) throw new TypeError("BranchUid cannot be empty");
  if (!looksLikeBranchUid(s)) {
    throw new TypeError(
      `'${s}' is not a BranchUid (must match the br-… pattern). ` +
        `If you have a BranchName (resource-path leaf like 'production'), use asBranchName() instead.`
    );
  }
  return s as BranchUid;
}

/**
 * Extract the BranchName leaf from a full resource path
 * `projects/<id>/branches/<NAME>`. Returns null when the path is not
 * shaped that way or when the leaf doesn't pass the BranchName validator
 * (e.g. it looks like a uid).
 */
export function branchNameFromResourcePath(path: string): BranchName | null {
  if (!path.includes("/branches/")) return null;
  const leaf = path.split("/branches/").pop();
  if (!leaf) return null;
  try {
    return asBranchName(leaf);
  } catch {
    return null;
  }
}
