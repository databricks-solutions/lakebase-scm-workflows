#!/usr/bin/env bash
# Run the PR schema-diff logic locally (no PR needed).
# Compares current branch DB (from .env) vs production (default Lakebase branch from CLI).
# Usage: ./scripts/prepare-schema-diff.sh
# Requires: .env with LAKEBASE_PROJECT_ID, Databricks auth; DATABASE_URL (or SPRING_DATASOURCE_*) for current branch; pg_dump (postgresql client).
set -e

WORK_TREE="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$WORK_TREE" ] && echo "prepare-schema-diff: run from a git repo." && exit 1
cd "$WORK_TREE"

if [ ! -f .env ]; then
  echo "prepare-schema-diff: .env not found. Copy .env.example to .env and set LAKEBASE_PROJECT_ID and Databricks auth."
  exit 1
fi
set -a
# shellcheck source=/dev/null
source .env 2>/dev/null || true
set +a

# Derive connection vars from DATABASE_URL if SPRING_DATASOURCE_* not set (backward compat)
if [ -z "${SPRING_DATASOURCE_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  SPRING_DATASOURCE_URL="jdbc:$(echo "$DATABASE_URL" | sed 's|^postgresql://[^@]*@|postgresql://|')"
  SPRING_DATASOURCE_USERNAME="${DB_USERNAME:-}"
  SPRING_DATASOURCE_PASSWORD="${DB_PASSWORD:-}"
fi

for var in LAKEBASE_PROJECT_ID SPRING_DATASOURCE_URL SPRING_DATASOURCE_USERNAME SPRING_DATASOURCE_PASSWORD; do
  eval "v=\$$var"
  if [ -z "$v" ]; then
    echo "prepare-schema-diff: $var not set in .env. Run 'git checkout <branch>' so the hook sets DATABASE_URL."
    exit 1
  fi
done

if ! command -v databricks >/dev/null 2>&1; then
  echo "prepare-schema-diff: databricks CLI not found."
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "prepare-schema-diff: jq is required (e.g. brew install jq)."
  exit 1
fi
HAVE_PG_DUMP=false
if command -v pg_dump >/dev/null 2>&1; then
  HAVE_PG_DUMP=true
else
  # Homebrew libpq (common on macOS)
  for p in /opt/homebrew/opt/libpq/bin/pg_dump /usr/local/opt/libpq/bin/pg_dump; do
    if [ -x "$p" ]; then
      export PATH="${p%/*}:$PATH"
      HAVE_PG_DUMP=true
      break
    fi
  done
fi
if [ "$HAVE_PG_DUMP" = false ]; then
  echo "prepare-schema-diff: pg_dump not found; will use Flyway migration version comparison only (no unified DDL diff)."
  echo "  Install PostgreSQL client for full diff (e.g. brew install libpq && brew link --force libpq)."
fi

BRANCH="${1:-$(git branch --show-current 2>/dev/null)}"
BRANCH="${BRANCH:-current-branch}"
# Sanitize for display (e.g. feature/foo -> feature-foo for label)
BRANCH_LABEL="$(echo "$BRANCH" | tr '/' '-')"
MD="schema-diff.md"

echo "## Schema (Lakebase branch \`${BRANCH_LABEL}\`)" > "$MD"
echo "" >> "$MD"
echo "### Migrations applied on this branch (CI)" >> "$MD"
echo "| Version | Migration |" >> "$MD"
echo "|---------|-----------|" >> "$MD"
for f in src/main/resources/db/migration/*.sql; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  ver=$(echo "$base" | sed -n 's/^V\([0-9]*\)__.*/\1/p')
  desc=$(echo "$base" | sed -n 's/^V[0-9]*__\(.*\)\.sql$/\1/p' | tr '_' ' ')
  [ -n "$ver" ] && echo "| V$ver | $desc |" >> "$MD"
done
echo "" >> "$MD"

PROJ_PATH="projects/${LAKEBASE_PROJECT_ID}"
DB_NAME="databricks_postgres"
PRODUCTION_DATASOURCE_URL=""
PRODUCTION_DATASOURCE_USERNAME=""
PRODUCTION_DATASOURCE_PASSWORD=""

echo "Resolving production (default branch) via Lakebase CLI..."
DEFAULT_UID="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null | jq -r '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select((.status.default == true) or (.is_default == true)) | (.uid // .id // (if .name then (.name | split("/") | last) else empty end))' | head -1)"
if [ -z "$DEFAULT_UID" ]; then
  echo "### Schema diff vs production" >> "$MD"
  echo "Production URL could not be resolved from Lakebase (default branch). Check LAKEBASE_PROJECT_ID and CLI auth." >> "$MD"
  echo "Wrote $MD (no production URL)."
  cat "$MD"
  exit 0
fi

BRANCH_PATH="${PROJ_PATH}/branches/${DEFAULT_UID}"
PROD_HOST="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null | jq -r '.[0].status.hosts.host // empty')"
if [ -z "$PROD_HOST" ]; then
  echo "Creating primary endpoint for default branch..."
  databricks postgres create-endpoint "$BRANCH_PATH" "primary" \
    --json '{"spec": {"endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "autoscaling_limit_min_cu": 2, "autoscaling_limit_max_cu": 4}}' 2>/dev/null || true
  for _ in $(seq 1 24); do
    state="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null | jq -r '.[0].status.current_state // empty')"
    [ "$state" = "ACTIVE" ] && break
    sleep 5
  done
  PROD_HOST="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null | jq -r '.[0].status.hosts.host // empty')"
fi
if [ -n "$PROD_HOST" ]; then
  PROD_TOKEN="$(databricks postgres generate-database-credential "${BRANCH_PATH}/endpoints/primary" -o json 2>/dev/null | jq -r '.token // empty')"
  PROD_EMAIL="$(databricks current-user me -o json 2>/dev/null | jq -r '.userName // .emails[0].value // empty')"
  if [ -n "$PROD_TOKEN" ] && [ -n "$PROD_EMAIL" ]; then
    PRODUCTION_DATASOURCE_URL="jdbc:postgresql://${PROD_HOST}:5432/${DB_NAME}?sslmode=require"
    PRODUCTION_DATASOURCE_USERNAME="$PROD_EMAIL"
    PRODUCTION_DATASOURCE_PASSWORD="$PROD_TOKEN"
  fi
fi

parse_jdbc() {
  local url="$1"
  local rest="${url#jdbc:postgresql://}"
  local hostport="${rest%%/*}"
  local path="${rest#*/}"
  local db="${path%%\?*}"
  local host="${hostport%:*}"
  local port="${hostport##*:}"
  [ "$port" = "$host" ] && port=5432
  echo "$host|$port|$db"
}

if [ -n "$PRODUCTION_DATASOURCE_URL" ]; then
  if [ "$HAVE_PG_DUMP" = true ]; then
    PROD_HP=$(parse_jdbc "$PRODUCTION_DATASOURCE_URL")
    CI_HP=$(parse_jdbc "$SPRING_DATASOURCE_URL")
    PROD_HOST=$(echo "$PROD_HP" | cut -d'|' -f1); PROD_PORT=$(echo "$PROD_HP" | cut -d'|' -f2); PROD_DB=$(echo "$PROD_HP" | cut -d'|' -f3)
    CI_HOST=$(echo "$CI_HP" | cut -d'|' -f1); CI_PORT=$(echo "$CI_HP" | cut -d'|' -f2); CI_DB=$(echo "$CI_HP" | cut -d'|' -f3)
    export PGSSLMODE=require
    SCHEMA_TMP=".tmp"
    mkdir -p "$SCHEMA_TMP"
    # Unsorted schema so formatter can parse CREATE TABLE ... ( columns ); blocks
    PROD_ERR=$(mktemp -t pg_dump_prod.XXXXXX)
    CI_ERR=$(mktemp -t pg_dump_ci.XXXXXX)
    trap "rm -f '$PROD_ERR' '$CI_ERR'" EXIT
    PGPASSWORD="${PRODUCTION_DATASOURCE_PASSWORD:-}" pg_dump -h "$PROD_HOST" -p "$PROD_PORT" -U "${PRODUCTION_DATASOURCE_USERNAME:-}" -d "$PROD_DB" --schema-only --no-owner --no-privileges 2>"$PROD_ERR" | grep -v '^--' | grep -v '^$' > "${SCHEMA_TMP}/prod-schema.sql" || true
    PGPASSWORD="${SPRING_DATASOURCE_PASSWORD:-}" pg_dump -h "$CI_HOST" -p "$CI_PORT" -U "${SPRING_DATASOURCE_USERNAME:-}" -d "$CI_DB" --schema-only --no-owner --no-privileges 2>"$CI_ERR" | grep -v '^--' | grep -v '^$' > "${SCHEMA_TMP}/ci-schema.sql" || true
    if [ -s "${SCHEMA_TMP}/prod-schema.sql" ] && [ -s "${SCHEMA_TMP}/ci-schema.sql" ]; then
      rm -f "$PROD_ERR" "$CI_ERR"
      trap - EXIT
      # Formatted schema diff from schema files
      echo "### Schema diff: \`${BRANCH_LABEL}\` vs production" >> "$MD"
      echo "" >> "$MD"
      SCRIPT_DIR="${BASH_SOURCE%/*}"
      [ -z "$SCRIPT_DIR" ] && SCRIPT_DIR="scripts"
      bash "${SCRIPT_DIR}/format-schema-diff.sh" "${SCHEMA_TMP}/prod-schema.sql" "${SCHEMA_TMP}/ci-schema.sql" >> "$MD" 2>/dev/null || true
    else
      echo "# pg_dump failed or empty; falling back to migration version comparison." >> "$MD"
      if [ ! -s "${SCHEMA_TMP}/prod-schema.sql" ] && [ -s "$PROD_ERR" ]; then
        REASON=$(head -1 "$PROD_ERR" 2>/dev/null | sed 's/^/# Production: /')
        echo "$REASON" >> "$MD"
        echo "prepare-schema-diff: production pg_dump failed: $(head -1 "$PROD_ERR" 2>/dev/null)" >&2
      fi
      if [ ! -s "${SCHEMA_TMP}/ci-schema.sql" ] && [ -s "$CI_ERR" ]; then
        REASON=$(head -1 "$CI_ERR" 2>/dev/null | sed 's/^/# CI branch: /')
        echo "$REASON" >> "$MD"
        echo "prepare-schema-diff: CI branch pg_dump failed: $(head -1 "$CI_ERR" 2>/dev/null)" >&2
      fi
      [ -s "${SCHEMA_TMP}/prod-schema.sql" ] || echo "# Tip: refresh production URL and credentials (e.g. ./scripts/connect-main-branch.sh)." >> "$MD"
      [ -s "${SCHEMA_TMP}/ci-schema.sql" ] || echo "# Tip: refresh branch credentials (e.g. ./scripts/refresh-token.sh)." >> "$MD"
      rm -f "$PROD_ERR" "$CI_ERR"
      trap - EXIT
      CI_INFO=$(./mvnw -q flyway:info -Dflyway.url="$SPRING_DATASOURCE_URL" -Dflyway.user="${SPRING_DATASOURCE_USERNAME:-}" -Dflyway.password="${SPRING_DATASOURCE_PASSWORD:-}" 2>/dev/null | grep "Success" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}' || true)
      PROD_INFO=$(./mvnw -q flyway:info -Dflyway.url="$PRODUCTION_DATASOURCE_URL" -Dflyway.user="${PRODUCTION_DATASOURCE_USERNAME:-}" -Dflyway.password="${PRODUCTION_DATASOURCE_PASSWORD:-}" 2>/dev/null | grep "Success" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}' || true)
      CI_VERS=$(echo "$CI_INFO" | tr '\n' ' '); PROD_VERS=$(echo "$PROD_INFO" | tr '\n' ' ')
      for v in $CI_VERS; do echo " $PROD_VERS " | grep -q " $v " || echo "**New on this PR:** V$v" >> "$MD"; done
      for v in $PROD_VERS; do echo " $CI_VERS " | grep -q " $v " || echo "**Only on production:** V$v" >> "$MD"; done
    fi
  else
    echo "### Schema diff vs production (migration versions)" >> "$MD"
    CI_INFO=$(./mvnw -q flyway:info -Dflyway.url="$SPRING_DATASOURCE_URL" -Dflyway.user="${SPRING_DATASOURCE_USERNAME:-}" -Dflyway.password="${SPRING_DATASOURCE_PASSWORD:-}" 2>/dev/null | grep "Success" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}' || true)
    PROD_INFO=$(./mvnw -q flyway:info -Dflyway.url="$PRODUCTION_DATASOURCE_URL" -Dflyway.user="${PRODUCTION_DATASOURCE_USERNAME:-}" -Dflyway.password="${PRODUCTION_DATASOURCE_PASSWORD:-}" 2>/dev/null | grep "Success" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}' || true)
    CI_VERS=$(echo "$CI_INFO" | tr '\n' ' '); PROD_VERS=$(echo "$PROD_INFO" | tr '\n' ' ')
    NEW_ON_CI=""; ON_BOTH=""; ONLY_PROD=""
    for v in $CI_VERS; do if echo " $PROD_VERS " | grep -q " $v "; then ON_BOTH="$ON_BOTH V$v"; else NEW_ON_CI="$NEW_ON_CI V$v"; fi; done
    for v in $PROD_VERS; do echo " $CI_VERS " | grep -q " $v " || ONLY_PROD="$ONLY_PROD V$v"; done
    [ -n "$NEW_ON_CI" ] && echo "**New on this branch (not on production):**$NEW_ON_CI" >> "$MD"
    [ -n "$ON_BOTH" ] && echo "**On both:**$ON_BOTH" >> "$MD"
    [ -n "$ONLY_PROD" ] && echo "**Only on production:**$ONLY_PROD" >> "$MD"
    [ -z "$NEW_ON_CI" ] && [ -z "$ONLY_PROD" ] && echo "**In sync:** This branch and production have the same migrations." >> "$MD"
  fi
else
  echo "### Schema diff vs production" >> "$MD"
  echo "Production URL could not be resolved from Lakebase (default branch)." >> "$MD"
fi

echo "Wrote $MD"
echo "---"
cat "$MD"
