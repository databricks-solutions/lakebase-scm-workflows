#!/usr/bin/env bash
# Resolve a Lakebase branch paired with a git branch, plus its endpoint +
# credentials + DATABASE_URL. Uses scripts/sanitize-branch-name.sh for the
# git→lakebase name mapping so CI and local dev agree (scripts/post-checkout.sh
# uses the same helper).
#
# Usage:
#   resolve-lakebase-branch.sh --git-branch <name> [flags]
#
# Flags:
#   --git-branch <name>          Git branch (main / staging / feature/x / ci-pr-N / ...)
#   --create-from <parent>       Create the Lakebase branch from <parent>'s Lakebase
#                                clone if it doesn't exist. <parent> is a GIT branch
#                                name (main / staging / ...). No-op if branch exists.
#   --lakebase-name <name>       Skip mapping – use this exact Lakebase branch name
#                                (overrides --git-branch mapping). Useful for ci-pr-N.
#   --github-env                 Append env vars to $GITHUB_ENV instead of stdout.
#   --ensure-endpoint            Create the primary endpoint if it doesn't exist.
#   --recreate-on-source-mismatch When the Lakebase branch already exists but
#                                was forked from a different source than
#                                --create-from asks for, delete and re-fork it
#                                from the requested source. Without this flag,
#                                the helper exits 1 on mismatch instead of
#                                silently using the wrong fork. Intended for
#                                disposable CI branches (ci-pr-*).
#
# Requires env:  DATABRICKS_HOST, DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID
# Optional env:  LAKEBASE_DB_NAME (default: databricks_postgres)
#
# Outputs (shell key=value OR appended to $GITHUB_ENV):
#   LAKEBASE_BRANCH_NAME   – e.g. "staging" / "feature-foo" / "ci-pr-42"
#   LAKEBASE_BRANCH_PATH   – projects/<id>/branches/<name>
#   LAKEBASE_BRANCH_STATUS – one of: CREATED (new), VERIFIED (existed + source
#                                     matched), RECREATED (existed but wrong
#                                     source, deleted + re-forked), EXISTS
#                                     (existed, source not verified because
#                                     --create-from not given), UNVERIFIED
#                                     (existed but API did not report a
#                                     source_branch – can't confirm parent)
#   LAKEBASE_BRANCH_SOURCE – the actual source branch name (or empty)
#   LAKEBASE_HOST          – endpoint hostname
#   LAKEBASE_USERNAME      – user email (OAuth "user" for psql)
#   LAKEBASE_PASSWORD      – OAuth token (secret – never echo to logs)
#   DATABASE_URL           – postgresql:// URL with embedded creds
#   JDBC_URL               – jdbc:postgresql:// URL (no creds; Java auth uses DB_USERNAME/DB_PASSWORD)

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANITIZE="${SCRIPT_DIR}/../sanitize-branch-name.sh"
[ -x "$SANITIZE" ] || {
  echo "resolve-lakebase-branch: cannot find $SANITIZE – scripts/sanitize-branch-name.sh must exist and be executable" >&2
  exit 1
}

GIT_BRANCH=""
CREATE_FROM=""
LAKEBASE_NAME_OVERRIDE=""
GH_ENV_MODE=0
ENSURE_ENDPOINT=0
RECREATE_ON_MISMATCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --git-branch)    GIT_BRANCH="$2"; shift 2 ;;
    --create-from)   CREATE_FROM="$2"; shift 2 ;;
    --lakebase-name) LAKEBASE_NAME_OVERRIDE="$2"; shift 2 ;;
    --github-env)    GH_ENV_MODE=1; shift ;;
    --ensure-endpoint) ENSURE_ENDPOINT=1; shift ;;
    --recreate-on-source-mismatch) RECREATE_ON_MISMATCH=1; shift ;;
    *) echo "resolve-lakebase-branch: unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -n "$GIT_BRANCH" ] || [ -n "$LAKEBASE_NAME_OVERRIDE" ] || {
  echo "resolve-lakebase-branch: --git-branch or --lakebase-name required" >&2
  exit 2
}
[ -n "${LAKEBASE_PROJECT_ID:-}" ] || {
  echo "resolve-lakebase-branch: LAKEBASE_PROJECT_ID env not set" >&2
  exit 2
}

command -v databricks >/dev/null 2>&1 || { echo "databricks CLI not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 1; }

PROJ_PATH="projects/${LAKEBASE_PROJECT_ID}"
DB_NAME="${LAKEBASE_DB_NAME:-databricks_postgres}"

# Fetch list-branches once (expensive CLI call) and cache JSON for downstream
# jq filters. Shape varies: array root, {branches:[]}, or {items:[]}.
_BRANCHES_RAW="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null || echo "[]")"
BRANCHES_JSON="$(echo "$_BRANCHES_RAW" | jq -c '
  if type == "array" then .
  elif type == "object" then (.branches // .items // [])
  else [] end' 2>/dev/null || echo "[]")"

# Return the Lakebase branch NAME that matches a given git branch.
# main/master → Lakebase default branch (dynamic, via list-branches)
# anything else → sanitize-branch-name.sh output
git_to_lakebase_name() {
  local git="$1"
  if [ "$git" = "main" ] || [ "$git" = "master" ]; then
    echo "$BRANCHES_JSON" | jq -r '
      .[] | select((.status.default == true) or (.is_default == true))
      | (if .name then (.name | split("/") | last) else (.uid // .id // empty) end)
    ' | head -1
  else
    "$SANITIZE" "$git"
  fi
}

# Check whether a Lakebase branch with this name exists. Prints its current_state
# (READY, CREATING, etc.) or empty if not found.
branch_state() {
  local name="$1"
  echo "$BRANCHES_JSON" | jq -r --arg n "$name" '
    .[] | select(
      (.name | type == "string" and (endswith("/branches/" + $n) or (split("/") | last == $n)))
      or (.uid == $n) or (.id == $n)
    ) | .status.current_state // empty
  ' | head -1
}

# Return the branch NAME (last path segment) that the given branch was forked
# from. Empty if the API didn't record a source (root branches, or branches
# created before source tracking shipped).
branch_source_name() {
  local name="$1"
  echo "$BRANCHES_JSON" | jq -r --arg n "$name" '
    .[] | select(
      (.name | type == "string" and (endswith("/branches/" + $n) or (split("/") | last == $n)))
      or (.uid == $n) or (.id == $n)
    ) | (.status.source_branch // empty)
    | (if . == "" then empty else (split("/") | last) end)
  ' | head -1
}

# Refresh the cached BRANCHES_JSON (needed after create/delete mutations).
refresh_branches_cache() {
  _BRANCHES_RAW="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null || echo "[]")"
  BRANCHES_JSON="$(echo "$_BRANCHES_RAW" | jq -c '
    if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end' 2>/dev/null || echo "[]")"
}

# Create LAKEBASE_NAME forked from SOURCE_NAME and wait until READY. Exits 1
# on timeout. Assumes caller has verified SOURCE_NAME is non-empty.
do_create_and_wait() {
  local source_name="$1"
  databricks postgres create-branch "$PROJ_PATH" "$LAKEBASE_NAME" \
    --json "{\"spec\": {\"source_branch\": \"${PROJ_PATH}/branches/${source_name}\", \"no_expiry\": true}}" \
    >/dev/null 2>&1 || true
  # Wait for READY (up to 2 min).
  for _ in $(seq 1 24); do
    sleep 5
    refresh_branches_cache
    STATE="$(branch_state "$LAKEBASE_NAME")"
    [ "$STATE" = "READY" ] && return 0
  done
  echo "resolve-lakebase-branch: branch '$LAKEBASE_NAME' did not reach READY (state: ${STATE:-unknown})" >&2
  exit 1
}

# Delete LAKEBASE_NAME and wait until the branch is gone from the list.
do_delete_and_wait() {
  databricks postgres delete-branch "$BRANCH_PATH" >/dev/null 2>&1 || true
  # Wait for deletion to propagate (up to 1 min).
  for _ in $(seq 1 30); do
    sleep 2
    refresh_branches_cache
    STATE="$(branch_state "$LAKEBASE_NAME")"
    [ -z "$STATE" ] && return 0
  done
  echo "resolve-lakebase-branch: delete of '$LAKEBASE_NAME' did not propagate in time (state: ${STATE:-?})" >&2
  exit 1
}

# ── Resolve the target Lakebase branch name ──────────────────────
if [ -n "$LAKEBASE_NAME_OVERRIDE" ]; then
  LAKEBASE_NAME="$LAKEBASE_NAME_OVERRIDE"
else
  LAKEBASE_NAME="$(git_to_lakebase_name "$GIT_BRANCH")"
fi

[ -n "$LAKEBASE_NAME" ] || {
  echo "resolve-lakebase-branch: could not map git '$GIT_BRANCH' to a Lakebase branch name" >&2
  exit 1
}

BRANCH_PATH="${PROJ_PATH}/branches/${LAKEBASE_NAME}"

# ── Ensure the branch exists AND is forked from the right source ─
# Four cases, driven by (does it exist?) x (was --create-from given?):
#   exists=no, create-from=no   → hard error (nothing to do)
#   exists=no, create-from=yes  → create + wait. STATUS=CREATED
#   exists=yes, create-from=no  → use as-is, no verification. STATUS=EXISTS
#   exists=yes, create-from=yes → VERIFY source matches. If it does, STATUS=VERIFIED.
#                                 If it doesn't: RECREATED (w/ flag) or error.
#                                 If API didn't record a source, STATUS=UNVERIFIED.
BRANCH_STATUS=""
LAKEBASE_BRANCH_SOURCE=""
STATE="$(branch_state "$LAKEBASE_NAME")"

if [ -z "$STATE" ]; then
  if [ -n "$CREATE_FROM" ]; then
    SOURCE_NAME="$(git_to_lakebase_name "$CREATE_FROM")"
    [ -n "$SOURCE_NAME" ] || {
      echo "resolve-lakebase-branch: could not resolve source branch for '$CREATE_FROM'" >&2
      exit 1
    }
    do_create_and_wait "$SOURCE_NAME"
    BRANCH_STATUS="CREATED"
    LAKEBASE_BRANCH_SOURCE="$SOURCE_NAME"
  else
    echo "resolve-lakebase-branch: branch '$LAKEBASE_NAME' does not exist and --create-from not given" >&2
    exit 1
  fi
else
  # Branch exists. If --create-from was given, verify the source matches.
  if [ -n "$CREATE_FROM" ]; then
    EXPECTED_SOURCE="$(git_to_lakebase_name "$CREATE_FROM")"
    ACTUAL_SOURCE="$(branch_source_name "$LAKEBASE_NAME")"
    LAKEBASE_BRANCH_SOURCE="$ACTUAL_SOURCE"
    if [ -z "$ACTUAL_SOURCE" ]; then
      echo "resolve-lakebase-branch: branch '$LAKEBASE_NAME' exists but source_branch is not recorded; using as-is without verification." >&2
      BRANCH_STATUS="UNVERIFIED"
    elif [ "$ACTUAL_SOURCE" = "$EXPECTED_SOURCE" ]; then
      echo "resolve-lakebase-branch: branch '$LAKEBASE_NAME' exists and was forked from '$ACTUAL_SOURCE' (as expected)." >&2
      BRANCH_STATUS="VERIFIED"
    else
      if [ "$RECREATE_ON_MISMATCH" = "1" ]; then
        echo "resolve-lakebase-branch: branch '$LAKEBASE_NAME' was forked from '$ACTUAL_SOURCE' but parent '$EXPECTED_SOURCE' was requested. Deleting and re-forking..." >&2
        do_delete_and_wait
        do_create_and_wait "$EXPECTED_SOURCE"
        BRANCH_STATUS="RECREATED"
        LAKEBASE_BRANCH_SOURCE="$EXPECTED_SOURCE"
      else
        echo "resolve-lakebase-branch: branch '$LAKEBASE_NAME' was forked from '$ACTUAL_SOURCE' but parent '$EXPECTED_SOURCE' was requested." >&2
        echo "resolve-lakebase-branch: pass --recreate-on-source-mismatch to delete and re-fork, or delete '$LAKEBASE_NAME' manually before re-running." >&2
        exit 1
      fi
    fi
  else
    BRANCH_STATUS="EXISTS"
    LAKEBASE_BRANCH_SOURCE="$(branch_source_name "$LAKEBASE_NAME")"
  fi
fi

# ── Get (or ensure) the primary endpoint ─────────────────────────
HOST="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null \
  | jq -r '.[0].status.hosts.host // empty')"

if [ -z "$HOST" ] && [ "$ENSURE_ENDPOINT" = "1" ]; then
  databricks postgres create-endpoint "$BRANCH_PATH" "primary" \
    --json '{"spec": {"endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "autoscaling_limit_min_cu": 2, "autoscaling_limit_max_cu": 4}}' \
    >/dev/null 2>&1 || true
  for _ in $(seq 1 24); do
    EP_STATE="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null \
      | jq -r '.[0].status.current_state // empty')"
    [ "$EP_STATE" = "ACTIVE" ] && break
    sleep 5
  done
  HOST="$(databricks postgres list-endpoints "$BRANCH_PATH" -o json 2>/dev/null \
    | jq -r '.[0].status.hosts.host // empty')"
fi

[ -n "$HOST" ] || {
  echo "resolve-lakebase-branch: no endpoint for '$LAKEBASE_NAME' (pass --ensure-endpoint to create)" >&2
  exit 1
}

# ── Mint credentials ─────────────────────────────────────────────
TOKEN="$(databricks postgres generate-database-credential "${BRANCH_PATH}/endpoints/primary" -o json 2>/dev/null \
  | jq -r '.token // empty')"
EMAIL="$(databricks current-user me -o json 2>/dev/null \
  | jq -r '.userName // .emails[0].value // empty')"

[ -n "$TOKEN" ] && [ -n "$EMAIL" ] || {
  echo "resolve-lakebase-branch: could not mint credentials for '$LAKEBASE_NAME'" >&2
  exit 1
}

# URL-encode chars that break postgres:// parsing. The email username
# ALWAYS contains '@' (e.g. user@example.com) and without encoding,
# psycopg/libpq split the DSN at the wrong '@' and resolve the literal
# email domain as the host.
ENCODED_USER="$(printf '%s' "$EMAIL" | sed 's/@/%40/g; s/:/%3A/g; s/\//%2F/g; s/?/%3F/g; s/#/%23/g')"
ENCODED_PASS="$(printf '%s' "$TOKEN" | sed 's/@/%40/g; s/:/%3A/g; s/\//%2F/g; s/?/%3F/g; s/#/%23/g')"
PG_URL="postgresql://${ENCODED_USER}:${ENCODED_PASS}@${HOST}:5432/${DB_NAME}?sslmode=require"
JDBC_URL="jdbc:postgresql://${HOST}:5432/${DB_NAME}?sslmode=require"

# ── Emit output ──────────────────────────────────────────────────
# GH env mode writes each var to $GITHUB_ENV. Multi-line-safe for tokens
# via heredoc delimiter. Stdout mode emits shell key=value for eval.
if [ "$GH_ENV_MODE" = "1" ] && [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "LAKEBASE_BRANCH_NAME=${LAKEBASE_NAME}"
    echo "LAKEBASE_BRANCH_PATH=${BRANCH_PATH}"
    echo "LAKEBASE_BRANCH_STATUS=${BRANCH_STATUS}"
    echo "LAKEBASE_BRANCH_SOURCE=${LAKEBASE_BRANCH_SOURCE}"
    echo "LAKEBASE_HOST=${HOST}"
    echo "LAKEBASE_USERNAME=${EMAIL}"
    echo "LAKEBASE_PASSWORD<<__LB_PW_EOF__"
    printf '%s\n' "$TOKEN"
    echo "__LB_PW_EOF__"
    echo "DATABASE_URL=${PG_URL}"
    echo "JDBC_URL=${JDBC_URL}"
    echo "DB_USERNAME=${EMAIL}"
    echo "DB_PASSWORD<<__LB_PW_EOF__"
    printf '%s\n' "$TOKEN"
    echo "__LB_PW_EOF__"
    echo "SPRING_DATASOURCE_URL=${JDBC_URL}"
    echo "SPRING_DATASOURCE_USERNAME=${EMAIL}"
    echo "SPRING_DATASOURCE_PASSWORD<<__LB_PW_EOF__"
    printf '%s\n' "$TOKEN"
    echo "__LB_PW_EOF__"
  } >> "$GITHUB_ENV"
  # Also emit NON-SECRET vars to stdout as shell key='value' lines so the
  # caller can `eval` them and get access WITHIN THE SAME STEP (writes to
  # $GITHUB_ENV only take effect in subsequent steps). Tokens and DATABASE_URL
  # (which embeds the token) are deliberately omitted – those stay in
  # $GITHUB_ENV and reach downstream steps via env-context masking.
  cat <<EOF
LAKEBASE_BRANCH_NAME='${LAKEBASE_NAME}'
LAKEBASE_BRANCH_PATH='${BRANCH_PATH}'
LAKEBASE_BRANCH_STATUS='${BRANCH_STATUS}'
LAKEBASE_BRANCH_SOURCE='${LAKEBASE_BRANCH_SOURCE}'
LAKEBASE_HOST='${HOST}'
LAKEBASE_USERNAME='${EMAIL}'
JDBC_URL='${JDBC_URL}'
EOF
else
  # Stdout: shell-eval format. Caller: eval "$(resolve-lakebase-branch.sh ...)"
  cat <<EOF
LAKEBASE_BRANCH_NAME='${LAKEBASE_NAME}'
LAKEBASE_BRANCH_PATH='${BRANCH_PATH}'
LAKEBASE_BRANCH_STATUS='${BRANCH_STATUS}'
LAKEBASE_BRANCH_SOURCE='${LAKEBASE_BRANCH_SOURCE}'
LAKEBASE_HOST='${HOST}'
LAKEBASE_USERNAME='${EMAIL}'
LAKEBASE_PASSWORD='${TOKEN}'
DATABASE_URL='${PG_URL}'
JDBC_URL='${JDBC_URL}'
EOF
fi
