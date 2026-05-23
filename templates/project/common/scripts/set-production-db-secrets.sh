#!/usr/bin/env bash
# Resolve production (default) Lakebase branch URL and credentials, then set
# DATABASE_URL, DB_USERNAME, DB_PASSWORD (and SPRING_DATASOURCE_* for backward compat)
# as GitHub repository secrets so the Merge workflow can run Flyway on production.
# Usage: from repo root, with .env (or env) containing LAKEBASE_PROJECT_ID and
#   Databricks auth (DATABRICKS_HOST, DATABRICKS_TOKEN or databricks auth login).
#   Requires: gh (gh auth login) or GITHUB_TOKEN + set-repo-secrets-api.py for more secrets.
set -e

WORK_TREE="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$WORK_TREE" ] && cd "$WORK_TREE"
[ -f .env ] && set -a && source .env 2>/dev/null && set +a

PROJ_ID="${LAKEBASE_PROJECT_ID:-}"
export DATABRICKS_HOST="${DATABRICKS_HOST:-}"
export DATABRICKS_TOKEN="${DATABRICKS_TOKEN:-}"

if [ -z "$PROJ_ID" ]; then
  echo "set-production-db-secrets: set LAKEBASE_PROJECT_ID in .env or environment."
  exit 1
fi
if ! command -v databricks >/dev/null 2>&1; then
  echo "set-production-db-secrets: databricks CLI not found."
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "set-production-db-secrets: jq required. Install: brew install jq"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "set-production-db-secrets: gh CLI required. Install gh and run 'gh auth login'."
  exit 1
fi

PROJ_PATH="projects/${PROJ_ID}"
DB_NAME="databricks_postgres"

# Default (main) Lakebase branch
DEFAULT_UID="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null \
  | jq -r '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select((.status.default == true) or (.is_default == true)) | (.uid // .id // (if .name then (.name | split("/") | last) else empty end))' | head -1)"
if [ -z "$DEFAULT_UID" ]; then
  # Single-branch fallback
  DEFAULT_UID="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null \
    | jq -r '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[0] | (.uid // .id // (if .name then (.name | split("/") | last) else empty end))')"
fi
if [ -z "$DEFAULT_UID" ]; then
  echo "set-production-db-secrets: could not find default Lakebase branch."
  exit 1
fi

BRANCH_PATH="${PROJ_PATH}/branches/${DEFAULT_UID}"
HOST="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null | jq -r '.[0].status.hosts.host // empty')"
if [ -z "$HOST" ]; then
  databricks postgres create-endpoint "$BRANCH_PATH" "primary" \
    --json '{"spec": {"endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "autoscaling_limit_min_cu": 2, "autoscaling_limit_max_cu": 4}}' 2>/dev/null || true
  for _ in $(seq 1 24); do
    state="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null | jq -r '.[0].status.current_state // empty')"
    [ "$state" = "ACTIVE" ] && break
    sleep 5
  done
  HOST="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null | jq -r '.[0].status.hosts.host // empty')"
fi
if [ -z "$HOST" ]; then
  echo "set-production-db-secrets: could not get endpoint host for production branch."
  exit 1
fi

TOKEN="$(databricks postgres generate-database-credential "${BRANCH_PATH}/endpoints/primary" -o json 2>/dev/null | jq -r '.token // empty')"
EMAIL="$(databricks current-user me -o json 2>/dev/null | jq -r '.userName // .emails[0].value // empty')"
if [ -z "$TOKEN" ] || [ -z "$EMAIL" ]; then
  echo "set-production-db-secrets: could not generate credential. Check databricks auth."
  exit 1
fi

# URL-encode the username (@ -> %40, etc.)
ENCODED_EMAIL="$(python3 -c "import urllib.parse; print(urllib.parse.quote('$EMAIL', safe=''))" 2>/dev/null || echo "$EMAIL")"
DATABASE_URL="postgresql://${ENCODED_EMAIL}:${TOKEN}@${HOST}:5432/${DB_NAME}?sslmode=require"
DB_USERNAME="$EMAIL"
DB_PASSWORD="$TOKEN"
SPRING_DATASOURCE_URL="jdbc:postgresql://${HOST}:5432/${DB_NAME}?sslmode=require"
SPRING_DATASOURCE_USERNAME="$EMAIL"
SPRING_DATASOURCE_PASSWORD="$TOKEN"

echo "Setting repository secrets for production (Merge workflow)..."
# Generic secrets (primary)
gh secret set DATABASE_URL --body "$DATABASE_URL"
gh secret set DB_USERNAME --body "$DB_USERNAME"
gh secret set DB_PASSWORD --body "$DB_PASSWORD"
# Spring-specific secrets (backward compat for existing Java workflows)
gh secret set SPRING_DATASOURCE_URL --body "$SPRING_DATASOURCE_URL"
gh secret set SPRING_DATASOURCE_USERNAME --body "$SPRING_DATASOURCE_USERNAME"
gh secret set SPRING_DATASOURCE_PASSWORD --body "$SPRING_DATASOURCE_PASSWORD"
echo "Done. Merge workflow will run Flyway on production when these secrets are set."