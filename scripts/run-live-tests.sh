#!/usr/bin/env bash
# Run the kit's live integration tests against a real Databricks workspace.
#
# Usage:
#   scripts/run-live-tests.sh              # migrate-live only (self-provisioning, default)
#   scripts/run-live-tests.sh --read-only  # tier 1 read-only suite against an existing branch
#   scripts/run-live-tests.sh --all        # both of the above + any other live suites
#
# Modes:
#
#   (default) migrate-live
#     Provisions its own Lakebase project on $DATABRICKS_HOST, runs the
#     four migrate primitives (apply / rollback / status / list), and
#     deletes the project on teardown. Project name is timestamp-suffixed.
#     Required env: DATABRICKS_HOST, LAKEBASE_TEST_E2E=1
#     Required tools: databricks CLI (authenticated), python3
#     (the script auto-provisions a Python venv at .venv-live-tests/ with
#     alembic + sqlalchemy + psycopg2-binary on first run)
#
#   --read-only
#     Read-only checks against an existing Lakebase branch. Mints
#     credentials, queries the schema, exercises diff + endpoint lookup.
#     Required env: LAKEBASE_TEST_INSTANCE, LAKEBASE_TEST_BRANCH
#     No project create/delete.
#
#   --all
#     Union of the above plus any other live tests vitest discovers when
#     the gating env is satisfied. Slow.
#
# Manual cleanup if a self-provisioned project leaks:
#   databricks postgres delete-project <projectId>

set -euo pipefail

MODE="migrate"
case "${1:-}" in
  --read-only) MODE="read-only" ;;
  --all)       MODE="all" ;;
  "")          MODE="migrate" ;;
  *)           echo "Unknown flag: $1. Use --read-only, --all, or no flag for migrate-live." >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

missing=0
require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    red "  missing \$$name"
    missing=1
  else
    green "  $name = ${!name}"
  fi
}
require_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    red "  $cmd not on PATH"
    yellow "    $hint"
    missing=1
  else
    green "  $cmd = $(command -v "$cmd")"
  fi
}

blue "==> Validating environment for mode: $MODE"

if [[ "$MODE" == "migrate" || "$MODE" == "all" ]]; then
  require_env DATABRICKS_HOST
  if [[ "${LAKEBASE_TEST_E2E:-}" != "1" ]]; then
    red "  LAKEBASE_TEST_E2E must be set to 1 (suite creates + deletes a Lakebase project)"
    missing=1
  else
    green "  LAKEBASE_TEST_E2E = 1"
  fi
  require_cmd databricks "install: https://docs.databricks.com/dev-tools/cli/install.html"
  require_cmd python3    "install: https://www.python.org/downloads/"
fi

if [[ "$MODE" == "read-only" || "$MODE" == "all" ]]; then
  require_env LAKEBASE_TEST_INSTANCE
  require_env LAKEBASE_TEST_BRANCH
fi

if [[ "$missing" -ne 0 ]]; then
  red ""
  red "Environment incomplete. See scripts/run-live-tests.sh header for required vars."
  exit 1
fi

# Provision a Python venv with alembic + sqlalchemy + psycopg2-binary
# for the migrate-live suite. Idempotent: skips creation if .venv-live-tests
# already exists with alembic in it. Prepends the venv to PATH so the test
# subprocess finds `alembic`.
if [[ "$MODE" == "migrate" || "$MODE" == "all" ]]; then
  VENV="$REPO_ROOT/.venv-live-tests"
  if [[ ! -x "$VENV/bin/alembic" ]]; then
    blue ""
    blue "==> Provisioning Python venv at $VENV (one-time setup)"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip
    "$VENV/bin/pip" install --quiet alembic sqlalchemy psycopg2-binary
  fi
  green "  using alembic from $VENV/bin/alembic"
  export PATH="$VENV/bin:$PATH"
fi

# Build dist so the test fixtures import the latest compiled substrate.
blue ""
blue "==> Building dist/"
npm run build >/dev/null

if [[ "$MODE" == "migrate" || "$MODE" == "all" ]]; then
  yellow ""
  yellow "==> About to create a Lakebase project on your workspace"
  yellow "    workspace:    $DATABRICKS_HOST"
  yellow "    project name: migrate-7091-<timestamp>"
  yellow "    cleanup:      automatic in afterAll() with 3-attempt retry"
  yellow "    manual fix:   databricks postgres delete-project <id>  (if cleanup leaks)"
  yellow ""
  yellow "    Press Ctrl-C in the next 5 seconds to abort. Setting LAKEBASE_TEST_NO_PROMPT=1"
  yellow "    in CI skips this pause."
  if [[ "${LAKEBASE_TEST_NO_PROMPT:-}" != "1" ]]; then
    sleep 5
  fi
fi

blue ""
blue "==> Running live tests (mode: $MODE)"

case "$MODE" in
  migrate)
    npx vitest run tests/bdd/migrate-live.test.ts
    ;;
  read-only)
    npx vitest run \
      tests/bdd/branch-utils.test.ts \
      tests/bdd/branch-endpoint.test.ts \
      tests/bdd/branch-schema.test.ts \
      tests/bdd/get-connection-dsn.test.ts \
      tests/bdd/get-connection-pool.test.ts \
      tests/bdd/get-connection-equivalence.test.ts \
      tests/bdd/lakebase-project.test.ts \
      tests/bdd/schema-diff-equivalence.test.ts
    ;;
  all)
    npx vitest run
    ;;
esac

green ""
green "==> Live tests passed (mode: $MODE)."
