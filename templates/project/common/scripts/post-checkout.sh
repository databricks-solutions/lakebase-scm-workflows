#!/usr/bin/env bash
# Post-checkout hook: create a Lakebase database branch for the current Git branch.
# Install: ./scripts/install-hook.sh
# Only runs on branch checkout (third argument is 1). See: https://git-scm.com/docs/githooks#_post_checkout

set -e
PREV_HEAD="$1"
NEW_HEAD="$2"
BRANCH_CHECKOUT="$3"

if [ "$BRANCH_CHECKOUT" != "1" ]; then
  exit 0
fi

WORK_TREE="$(git rev-parse --show-toplevel)"
cd "$WORK_TREE"

# Detached HEAD: skip
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  exit 0
fi

# Scope guard: this hook only activates when a project-level .env exists at
# the work-tree root. In monorepos where the hook is installed at a parent
# repo's git dir but the Lakebase project's .env lives in a subdirectory,
# this prevents the hook from firing on unrelated branch checkouts. If
# .env.example exists, bootstrap .env from it once and exit so the user
# can populate LAKEBASE_PROJECT_ID before the next checkout.
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "Lakebase: created .env from .env.example. Set LAKEBASE_PROJECT_ID and run checkout again."
  fi
  exit 0
fi

# Clobber any inherited LAKEBASE_* / DATABRICKS_* env so this hook acts only
# on what's in the project .env. Otherwise a user who sourced an activation
# script earlier in the shell would leak LAKEBASE_PROJECT_ID into every
# git checkout in unrelated repos and create spurious branches.
unset LAKEBASE_PROJECT_ID \
      LAKEBASE_BASE_BRANCH LAKEBASE_HOST LAKEBASE_BRANCH_ID \
      DATABRICKS_CONFIG_PROFILE DATABRICKS_HOST DATABASE_URL \
      DB_USERNAME DB_PASSWORD

set -a
# shellcheck source=/dev/null
source .env 2>/dev/null || true
set +a

# Capture the Lakebase branch the user was on BEFORE this checkout. The hook
# will rewrite .env for the new branch, so this is our only chance to record
# the "previous" state – used below as the default fork source for new
# feature branches (mirrors `git checkout -b`'s "fork from current").
PREV_LAKEBASE_BRANCH_ID="${LAKEBASE_BRANCH_ID:-}"

# --- Prerequisites ---
PROJ_ID="${LAKEBASE_PROJECT_ID:-}"
if [ -z "$PROJ_ID" ]; then
  # .env exists but no project id -- likely a fresh bootstrap. Stay quiet
  # to avoid nagging on every checkout.
  exit 0
fi

# Auto-discover the git trunk branch from `origin/HEAD` so a non-`main`
# trunk (e.g. `release/v3` in some shared-monorepo conventions) doesn't
# need a per-project env var. `git clone` sets refs/remotes/origin/HEAD
# to the remote's default branch; that's the authoritative answer for
# "what's this repo's trunk." If origin/HEAD isn't set (rare; some
# self-hosted CI clones strip it), TRUNK_ALIAS stays empty and the
# fallback below treats `main`/`master` as trunk. Other long-running
# tiers (staging, uat, perf, ...) are auto-discovered later from the
# Lakebase branch list - no per-tier env var needed.
TRUNK_ALIAS="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"

if ! command -v databricks >/dev/null 2>&1; then
  echo "Lakebase: databricks CLI not found. Install and run 'databricks auth login'."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Lakebase: jq is required. Install: brew install jq"
  exit 1
fi

# --- Auth preflight: verify CLI can reach Databricks before doing anything ---
# .env is already sourced above, so DATABRICKS_CONFIG_PROFILE (if set) is already exported.
if ! databricks current-user me -o json >/dev/null 2>&1; then
  echo "Lakebase: Databricks CLI auth failed. Re-authenticate and then re-trigger the hook:"
  if [ -n "${DATABRICKS_CONFIG_PROFILE:-}" ]; then
    echo "  databricks auth login --profile ${DATABRICKS_CONFIG_PROFILE} --host ${DATABRICKS_HOST:-<workspace-url>}"
  else
    echo "  databricks auth login --host ${DATABRICKS_HOST:-<workspace-url>}"
    echo "  Tip: set DATABRICKS_CONFIG_PROFILE in .env to pin a specific CLI profile."
  fi
  echo "  Then: git checkout - && git checkout $BRANCH"
  exit 0  # don't block the git checkout itself
fi

PROJ_PATH="projects/${PROJ_ID}"
DB_NAME="databricks_postgres"

# --- Helper: npm install in client/ on first checkout or when node_modules is absent ---
# Runs silently after Lakebase setup so switching branches is fully self-contained.
maybe_npm_install() {
  if [ -f "$WORK_TREE/client/package.json" ] && [ ! -d "$WORK_TREE/client/node_modules" ]; then
    if command -v npm >/dev/null 2>&1; then
      echo "React client: node_modules missing – running npm install..."
      npm install --prefix "$WORK_TREE/client" --silent
      echo "React client: ready."
    fi
  fi
}

# --- Helper: update .env and application-local.properties with connection info ---
# Maven/Spring do not load .env; they use application-local.properties (spring.config.import).
# So we must write the branch URL to both, or Maven will use whatever is in application-local.properties
# (e.g. production from a previous run) and schema would go to the wrong branch.
update_env() {
  local host="$1" user="$2" pass="$3" branch_id="$4"
  # URL-encode the username (@ -> %40, etc.)
  local encoded_user
  encoded_user="$(python3 -c "import urllib.parse; print(urllib.parse.quote('$user', safe=''))" 2>/dev/null || echo "$user")"
  local database_url="postgresql://${encoded_user}:${pass}@${host}:5432/${DB_NAME}?sslmode=require"

  if [ -f .env ]; then
    grep -v "^DATABASE_URL=" .env \
      | grep -v "^DB_USERNAME=" \
      | grep -v "^DB_PASSWORD=" \
      | grep -v "^LAKEBASE_BRANCH_ID=" \
      | grep -v "^LAKEBASE_HOST=" \
      > .env.tmp 2>/dev/null || true
  else
    touch .env.tmp
  fi

  {
    echo "LAKEBASE_HOST=${host}"
    echo "LAKEBASE_BRANCH_ID=${branch_id}"
    echo "DATABASE_URL=${database_url}"
    echo "DB_USERNAME=${user}"
    echo "DB_PASSWORD=${pass}"
  } >> .env.tmp

  mv .env.tmp .env

  # Write application-local.properties only for Java/Spring projects (pom.xml present)
  if [ -f pom.xml ]; then
    local jdbc_url="jdbc:postgresql://${host}:5432/${DB_NAME}?sslmode=require"
    {
      echo "# Auto-generated by post-checkout hook for branch: ${branch_id}"
      echo "spring.datasource.url=${jdbc_url}"
      echo "spring.datasource.username=${user}"
      echo "spring.datasource.password=${pass}"
    } > application-local.properties
  fi
}

# --- Helper: get credential and email ---
get_credential() {
  local endpoint_path="$1"
  TOKEN="$(databricks postgres generate-database-credential "$endpoint_path" -o json 2>/dev/null \
    | jq -r '.token // empty')"
  EMAIL="$(databricks current-user me -o json 2>/dev/null \
    | jq -r '.userName // .emails[0].value // empty')"
}

# --- Helper: get endpoint host, creating if needed ---
get_or_create_endpoint() {
  local branch_path="$1"
  local ep_host

  ep_host="$(databricks postgres list-endpoints "$branch_path" -o json 2>/dev/null \
    | jq -r '.[0].status.hosts.host // empty')"

  if [ -z "$ep_host" ]; then
    echo "Lakebase: creating endpoint..." >&2
    databricks postgres create-endpoint "$branch_path" "primary" \
      --json '{"spec": {"endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "autoscaling_limit_min_cu": 2, "autoscaling_limit_max_cu": 4}}' >/dev/null 2>&1 || true

    echo "Lakebase: waiting for endpoint to be active..." >&2
    for _ in $(seq 1 24); do
      local state
      state="$(databricks postgres list-endpoints "$branch_path" -o json 2>/dev/null \
        | jq -r '.[0].status.current_state // empty')"
      [ "$state" = "ACTIVE" ] && break
      sleep 5
    done

    ep_host="$(databricks postgres list-endpoints "$branch_path" -o json 2>/dev/null \
      | jq -r '.[0].status.hosts.host // empty')"
  fi

  echo "$ep_host"
}

# --- Pull the Lakebase branch list once ---
# Used twice below: to discover the default branch UID (for the trunk path)
# AND to discover the set of long-running tier names (for the tier path).
# API returns { "branches": [ ... ] }; CLI may unwrap to [ ... ]. Support both.
BRANCH_LIST_JSON="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null || echo '[]')"

# Default branch: prefer the name component (last segment of .name) over uid –
# the create-branch API requires it.
DEFAULT_BRANCH_UID="$(echo "$BRANCH_LIST_JSON" \
  | jq -r '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select((.status.default == true) or (.is_default == true)) | (if .name then (.name | split("/") | last) else (.uid // .id // empty) end)' | head -1)"

if [ -z "$DEFAULT_BRANCH_UID" ]; then
  echo "Lakebase: could not find default branch. Check LAKEBASE_PROJECT_ID and CLI auth."
  exit 1
fi

# All non-default branch names (newline-separated). These are the long-running
# tiers the architect has cut (staging, uat, perf, dev, ... or whatever they
# named them). A git checkout to a name in this list is a tier checkout –
# point .env at the existing Lakebase branch of the same name, don't try to
# create a new one.
TIER_BRANCH_NAMES="$(echo "$BRANCH_LIST_JSON" \
  | jq -r '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select(((.status.default == true) or (.is_default == true)) | not) | (if .name then (.name | split("/") | last) else (.uid // .id // empty) end)' \
  | grep -v '^$' || true)"

# --- Trunk path: git trunk → Lakebase default ---
# Special-cased because the Lakebase default branch's name (e.g. `production`)
# may differ from the git trunk name (`main`). TRUNK_ALIAS is auto-derived
# from `origin/HEAD` above and naturally handles non-`main` trunks like
# `release/v3`. The `[ -z "$TRUNK_ALIAS" ]` arm is the fallback for clones
# where origin/HEAD wasn't set.
if { [ -n "$TRUNK_ALIAS" ] && [ "$BRANCH" = "$TRUNK_ALIAS" ]; } \
   || { [ -z "$TRUNK_ALIAS" ] && { [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; }; }; then
  echo "Lakebase: on $BRANCH, connecting to default Lakebase branch ($DEFAULT_BRANCH_UID)..."
  BRANCH_PATH="${PROJ_PATH}/branches/${DEFAULT_BRANCH_UID}"

  HOST="$(get_or_create_endpoint "$BRANCH_PATH")"
  if [ -z "$HOST" ]; then
    echo "Lakebase: could not get endpoint host for default branch."
    exit 0
  fi

  get_credential "${BRANCH_PATH}/endpoints/primary"
  if [ -z "$TOKEN" ] || [ -z "$EMAIL" ]; then
    echo "Lakebase: could not get credential. Set DATABASE_URL in .env manually."
    exit 0
  fi

  update_env "$HOST" "$EMAIL" "$TOKEN" "$DEFAULT_BRANCH_UID"
  echo "Lakebase: $BRANCH -> default branch ($DEFAULT_BRANCH_UID). Updated .env."
  maybe_npm_install
  exit 0
fi

# --- Tier path: git branch name matches an existing non-default Lakebase branch ---
# Auto-discovers any long-running tier the architect has cut (staging, uat,
# perf, dev, ...). The convention is: tier branches use the same name on both
# sides (git and Lakebase). No per-tier env alias is needed; if the Lakebase
# branch exists, this is a tier checkout. Tiers are never auto-created by
# this hook – the architect bootstraps them deliberately (see
# createLongRunningBranch in lakebase-app-dev-kit).
if [ -n "$TIER_BRANCH_NAMES" ] && echo "$TIER_BRANCH_NAMES" | grep -qxF "$BRANCH"; then
  echo "Lakebase: on $BRANCH, connecting to Lakebase tier '$BRANCH'..."
  BRANCH_PATH="${PROJ_PATH}/branches/${BRANCH}"

  HOST="$(get_or_create_endpoint "$BRANCH_PATH")"
  if [ -z "$HOST" ]; then
    echo "Lakebase: could not get endpoint host for tier '$BRANCH'."
    exit 0
  fi

  get_credential "${BRANCH_PATH}/endpoints/primary"
  if [ -z "$TOKEN" ] || [ -z "$EMAIL" ]; then
    echo "Lakebase: could not get credential for tier '$BRANCH'. Set DATABASE_URL in .env manually."
    exit 0
  fi

  update_env "$HOST" "$EMAIL" "$TOKEN" "$BRANCH"
  echo "Lakebase: $BRANCH -> tier '$BRANCH'. Updated .env."
  maybe_npm_install
  exit 0
fi

# --- Feature branch: create Lakebase branch from the configured base ---
# Sanitize git branch name for Lakebase branch ID.
# sanitize-branch-name.sh lives at <workTree>/scripts/; the installed hook
# at .git/hooks/post-checkout can't use $0-relative paths because git
# invokes it from outside the scripts/ directory.
LAKEBASE_BRANCH="$("$WORK_TREE/scripts/sanitize-branch-name.sh" "$BRANCH")"
BRANCH_PATH="${PROJ_PATH}/branches/${LAKEBASE_BRANCH}"

# Resolve the parent (source) Lakebase branch. Precedence:
#   1. LAKEBASE_BASE_BRANCH from .env – explicit 3-tier configuration wins
#      (e.g. LAKEBASE_BASE_BRANCH=staging for a feature → staging → prod flow).
#   2. The Lakebase branch the user was JUST ON (pre-checkout). Mirrors
#      `git checkout -b`'s semantics – the new feature inherits from
#      whichever branch you were working on. If you were on `staging`,
#      new features fork from `staging`; if you were on another feature,
#      the new one forks from it.
#   3. Project default (production) – first-time setup, or previous
#      branch's Lakebase state couldn't be resolved.
# The previous Lakebase branch is only usable as a source if it actually
# still exists and is READY; otherwise fall through to the default.
BASE_BRANCH_ID=""
if [ -n "${LAKEBASE_BASE_BRANCH:-}" ]; then
  BASE_BRANCH_ID="$LAKEBASE_BASE_BRANCH"
elif [ -n "$PREV_LAKEBASE_BRANCH_ID" ] && [ "$PREV_LAKEBASE_BRANCH_ID" != "$LAKEBASE_BRANCH" ]; then
  PREV_EXISTS="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null \
    | jq -r --arg uid "$PREV_LAKEBASE_BRANCH_ID" '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select((.name | type == "string" and (endswith("/branches/" + $uid) or (split("/") | last == $uid))) or (.uid == $uid) or (.id == $uid)) | (.name // .uid // .id)' | head -1)"
  if [ -n "$PREV_EXISTS" ]; then
    BASE_BRANCH_ID="$PREV_LAKEBASE_BRANCH_ID"
  fi
fi
BASE_BRANCH_ID="${BASE_BRANCH_ID:-$DEFAULT_BRANCH_UID}"
SOURCE_BRANCH="${PROJ_PATH}/branches/${BASE_BRANCH_ID}"

# Check if branch already exists
BRANCH_EXISTS="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null \
  | jq -r --arg uid "$LAKEBASE_BRANCH" '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select((.name | type == "string" and (endswith("/branches/" + $uid) or (split("/") | last == $uid))) or (.uid == $uid) or (.id == $uid)) | (.name // .uid // .id)' | head -1)"

if [ -z "$BRANCH_EXISTS" ]; then
  echo "Lakebase: creating branch '$LAKEBASE_BRANCH' from '$BASE_BRANCH_ID'..."
  CREATE_RESPONSE="$(databricks postgres create-branch "$PROJ_PATH" "$LAKEBASE_BRANCH" \
    --json "{\"spec\": {\"source_branch\": \"$SOURCE_BRANCH\", \"no_expiry\": true}}" 2>&1)" || true
  # Log fork point for audit trail
  FORK_LSN="$(echo "$CREATE_RESPONSE" | jq -r '.status.source_branch_lsn // empty' 2>/dev/null)"
  FORK_TIME="$(echo "$CREATE_RESPONSE" | jq -r '.status.source_branch_time // empty' 2>/dev/null)"
  [ -n "$FORK_LSN" ] && echo "Lakebase: forked at LSN=$FORK_LSN time=$FORK_TIME"
else
  echo "Lakebase: branch '$LAKEBASE_BRANCH' already exists."
fi

# Wait for branch READY (up to 2 min)
echo "Lakebase: waiting for branch to be ready..."
STATE=""
for _ in $(seq 1 24); do
  STATE="$(databricks postgres list-branches "$PROJ_PATH" -o json 2>/dev/null \
    | jq -r --arg uid "$LAKEBASE_BRANCH" '(if type == "array" then . elif type == "object" then (.branches // .items // []) else [] end) | .[] | select((.name | type == "string" and (endswith("/branches/" + $uid) or (split("/") | last == $uid))) or (.uid == $uid) or (.id == $uid)) | .status.current_state // empty' | head -1)"
  [ "$STATE" = "READY" ] && break
  sleep 5
done

if [ "$STATE" != "READY" ]; then
  echo "Lakebase: branch '$LAKEBASE_BRANCH' not ready (state: ${STATE:-unknown}). Try again later."
  exit 0
fi

# Get or create endpoint
HOST="$(get_or_create_endpoint "$BRANCH_PATH")"
if [ -z "$HOST" ]; then
  echo "Lakebase: could not get endpoint host for '$LAKEBASE_BRANCH'. Set DATABASE_URL in .env manually."
  exit 0
fi

# Generate credential
get_credential "${BRANCH_PATH}/endpoints/primary"
if [ -z "$TOKEN" ] || [ -z "$EMAIL" ]; then
  echo "Lakebase: could not get credential. Set DATABASE_URL in .env manually (host: $HOST)."
  exit 0
fi

update_env "$HOST" "$EMAIL" "$TOKEN" "$LAKEBASE_BRANCH"

# Verify connection works (non-blocking – skip if psql not available)
if command -v psql >/dev/null 2>&1; then
  if psql "host=$HOST port=5432 dbname=databricks_postgres user=$EMAIL password=$TOKEN sslmode=require" -c "SELECT 1" >/dev/null 2>&1; then
    echo "Lakebase: branch '$LAKEBASE_BRANCH' ready. Connection verified. Updated .env."
  else
    echo "Lakebase: branch '$LAKEBASE_BRANCH' ready but connection check failed. Retrying credential..."
    sleep 3
    get_credential "${BRANCH_PATH}/endpoints/primary"
    if [ -n "$TOKEN" ] && [ -n "$EMAIL" ]; then
      update_env "$HOST" "$EMAIL" "$TOKEN" "$LAKEBASE_BRANCH"
      if psql "host=$HOST port=5432 dbname=databricks_postgres user=$EMAIL password=$TOKEN sslmode=require" -c "SELECT 1" >/dev/null 2>&1; then
        echo "Lakebase: connection verified on retry."
      else
        echo "Lakebase: warning – connection still failing. .env updated but credentials may need manual refresh."
      fi
    fi
  fi
else
  echo "Lakebase: branch '$LAKEBASE_BRANCH' ready. Updated .env with DATABASE_URL."
fi
maybe_npm_install
