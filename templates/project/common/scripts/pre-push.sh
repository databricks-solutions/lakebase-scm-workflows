#!/usr/bin/env bash
# Pre-push hook: refresh OAuth token and sync to GitHub secrets before every push.
#
# OAuth tokens are short-lived (~1h). This hook ensures CI always has a fresh token
# by refreshing via `databricks auth token` and syncing to DATABRICKS_TOKEN in GitHub secrets.
#
# Install: ./scripts/install-hook.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env 2>/dev/null || true
  set +a
fi

# Refresh OAuth token before syncing — this is the critical step.
# CI workflows use DATABRICKS_TOKEN from GitHub secrets. If we don't refresh here,
# CI gets a stale token and auth fails on merge cleanup, migrations, etc.
if [ -n "${DATABRICKS_HOST:-}" ] && command -v databricks >/dev/null 2>&1; then
  PROFILE_FLAG=""
  [ -n "${DATABRICKS_CONFIG_PROFILE:-}" ] && PROFILE_FLAG="--profile ${DATABRICKS_CONFIG_PROFILE}"

  FRESH_TOKEN="$(databricks auth token $PROFILE_FLAG -o json 2>/dev/null | jq -r '.access_token // empty' 2>/dev/null)" || true
  if [ -n "$FRESH_TOKEN" ]; then
    export DATABRICKS_TOKEN="$FRESH_TOKEN"
    echo "Pre-push: OAuth token refreshed."
  else
    echo "Pre-push: ERROR — could not refresh OAuth token."
    echo "Pre-push: CI will fail with a stale token. Run 'databricks auth login' and try again."
    exit 1
  fi
fi

# Sync secrets to GitHub (DATABRICKS_HOST, DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID)
if [ -n "${DATABRICKS_HOST:-}" ] && [ -n "${LAKEBASE_PROJECT_ID:-}" ] && [ -n "${DATABRICKS_TOKEN:-}" ]; then
  if "$SCRIPT_DIR/set-repo-secrets.sh" 2>/dev/null; then
    echo "Pre-push: repository secrets synced."
  fi
  # If set-repo-secrets fails (e.g. no gh), push continues anyway
fi

exit 0
