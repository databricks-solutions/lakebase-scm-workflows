#!/usr/bin/env bash
# Sync repository secrets for CI/CD workflows.
#
# Auth: OAuth token refreshed by pre-push hook → synced as DATABRICKS_TOKEN.
# Required env vars: DATABRICKS_HOST, DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID
#
# Usage: called automatically by pre-push hook. Can also run manually:
#   export DATABRICKS_HOST=... DATABRICKS_TOKEN=... LAKEBASE_PROJECT_ID=...
#   ./scripts/set-repo-secrets.sh

set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || true
cd "${REPO_ROOT:-.}"

DATABRICKS_HOST="${DATABRICKS_HOST:-}"
DATABRICKS_TOKEN="${DATABRICKS_TOKEN:-}"
LAKEBASE_PROJECT_ID="${LAKEBASE_PROJECT_ID:-}"

if [ -z "$DATABRICKS_HOST" ] || [ -z "$DATABRICKS_TOKEN" ] || [ -z "$LAKEBASE_PROJECT_ID" ]; then
  echo "Missing required secrets: DATABRICKS_HOST, DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID"
  echo "The pre-push hook refreshes the token automatically. If running manually:"
  echo "  export DATABRICKS_TOKEN=\$(databricks auth token -o json | jq -r '.access_token')"
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  gh secret set DATABRICKS_HOST --body "$DATABRICKS_HOST"
  gh secret set DATABRICKS_TOKEN --body "$DATABRICKS_TOKEN"
  gh secret set LAKEBASE_PROJECT_ID --body "$LAKEBASE_PROJECT_ID"
  exit 0
fi

echo "Install the GitHub CLI (gh) and run 'gh auth login', then re-run."
exit 1
