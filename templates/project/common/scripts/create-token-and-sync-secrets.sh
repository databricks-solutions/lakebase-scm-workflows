#!/usr/bin/env bash
# Mint a Databricks PAT and sync it (plus DATABRICKS_HOST + LAKEBASE_PROJECT_ID)
# to GitHub repo secrets for CI.
#
# Prefers a long-lived PAT (90 days) over the OAuth session token so that
# GitHub Actions reruns — which can fire hours after the last push — do not
# silently fail when the short-lived (~1h) OAuth session expires. Falls back
# to OAuth only if the workspace disables PAT creation.
#
# The pre-push hook calls this on every push. Run it manually before:
#   - `gh pr create` / `gh run rerun` / manual workflow_dispatch triggers
#   - any time `databricks current-user me` starts failing in CI logs
#
# Prereq: run `databricks auth login` first. LAKEBASE_PROJECT_ID must be set (e.g. in .env).
# Usage: ./scripts/create-token-and-sync-secrets.sh

set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || true
cd "${REPO_ROOT:-.}"
SCRIPT_DIR="$(dirname "$0")"

# Load .env so LAKEBASE_PROJECT_ID (and optionally DATABRICKS_HOST) are available
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# Require jq and databricks
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install with: brew install jq (or apt-get install jq)"
  exit 1
fi
if ! command -v databricks >/dev/null 2>&1; then
  echo "databricks CLI is required. Install and run: databricks auth login"
  exit 1
fi

# Resolve DATABRICKS_HOST from auth env if not set
if [ -z "${DATABRICKS_HOST:-}" ]; then
  AUTH_JSON="$(databricks auth env -o json 2>/dev/null)" || true
  DATABRICKS_HOST="$(echo "${AUTH_JSON:-}" | jq -r '.env.DATABRICKS_HOST // empty' 2>/dev/null)" || true
fi
if [ -z "${DATABRICKS_HOST:-}" ]; then
  echo "DATABRICKS_HOST not set and could not be read from 'databricks auth env'. Run 'databricks auth login' or set DATABRICKS_HOST in .env"
  exit 1
fi

# LAKEBASE_PROJECT_ID must be set (e.g. in .env)
if [ -z "${LAKEBASE_PROJECT_ID:-}" ]; then
  echo "LAKEBASE_PROJECT_ID is required. Set it in .env or export it, then re-run this script."
  exit 1
fi

# Resolve CLI profile for this workspace
PROFILE=""
if [ -n "${DATABRICKS_CONFIG_PROFILE:-}" ]; then
  PROFILE="--profile ${DATABRICKS_CONFIG_PROFILE}"
elif grep -q "$(echo "$DATABRICKS_HOST" | sed 's|https://||; s|/$||')" ~/.databrickscfg 2>/dev/null; then
  PROFILE="--profile $(grep -B1 "$(echo "$DATABRICKS_HOST" | sed 's|https://||; s|/$||')" ~/.databrickscfg 2>/dev/null | head -1 | tr -d '[]')"
fi

# Prefer a long-lived PAT (90 days by default) so CI reruns past the ~1h
# OAuth session lifetime don't silently fail auth. Override via
# TOKEN_LIFETIME_SECONDS; the API caps workspace-token lifetimes per tenant.
TOKEN_KIND=""
REPO_NAME="$(basename "$(git remote get-url origin 2>/dev/null)" 2>/dev/null | sed 's/\.git$//')" || REPO_NAME="repo"
COMMENT="GitHub Actions ($REPO_NAME)"
LIFETIME_SECONDS="${TOKEN_LIFETIME_SECONDS:-7776000}"  # 90 days

echo "Minting PAT (${LIFETIME_SECONDS}s lifetime)..."
CREATE_OUT="$(databricks tokens create --comment "$COMMENT" --lifetime-seconds "$LIFETIME_SECONDS" -o json 2>&1)" || true
TOKEN_VALUE="$(echo "$CREATE_OUT" | jq -r '.token_value // .token // empty' 2>/dev/null)" || true
if [ -n "$TOKEN_VALUE" ]; then
  TOKEN_KIND="PAT (${LIFETIME_SECONDS}s)"
fi

# Fallback: OAuth session token (short-lived, ~1h) for workspaces where PATs
# are disabled. The pre-push hook will re-mint on every push; reruns that
# fire >1h after the last push will fail — prefer PAT if you can.
if [ -z "$TOKEN_VALUE" ]; then
  echo "PAT creation failed — workspace may have PATs disabled. Falling back to OAuth token..."
  TOKEN_VALUE="$(databricks auth token $PROFILE -o json 2>/dev/null | jq -r '.access_token // empty')" || true
  if [ -n "$TOKEN_VALUE" ]; then
    TOKEN_KIND="OAuth session (~1h)"
  fi
fi

if [ -z "$TOKEN_VALUE" ]; then
  echo "Failed to mint PAT or get OAuth token. Run 'databricks auth login' first."
  exit 1
fi

export DATABRICKS_HOST
export DATABRICKS_TOKEN="$TOKEN_VALUE"
export LAKEBASE_PROJECT_ID
echo "Token: $TOKEN_KIND. Syncing DATABRICKS_HOST, DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID to GitHub repo secrets..."
exec "$SCRIPT_DIR/set-repo-secrets.sh"
