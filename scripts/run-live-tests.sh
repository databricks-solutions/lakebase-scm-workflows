#!/usr/bin/env bash
# Run the kit's live integration tests against a real Databricks workspace.
#
# Usage:
#   scripts/run-live-tests.sh              # migrate-live (alembic + flyway), default
#   scripts/run-live-tests.sh --read-only  # tier 1 read-only suite against an existing branch
#   scripts/run-live-tests.sh --all        # both of the above + any other live suites
#
# Modes:
#
#   (default) migrate-live
#     Provisions its own Lakebase projects on $DATABRICKS_HOST and runs
#     the four migrate primitives (apply / rollback / status / list)
#     once with the Alembic runner against a Python project layout and
#     once with the Flyway runner against a Maven/Spring project layout.
#     Each test creates and tears down its own project, suffixed with a
#     timestamp.
#     Required env: DATABRICKS_HOST, LAKEBASE_TEST_E2E=1
#     Required tools: databricks CLI (authenticated), python3, java
#     The script auto-provisions on first run:
#       - .venv-live-tests/ (Python venv with alembic, sqlalchemy, psycopg2-binary)
#       - .tools-live-tests/flyway-<version>/ (Flyway Community Edition CLI)
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

FLYWAY_VERSION="10.20.1"

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
  require_cmd java       "install JDK 17+: https://adoptium.net/  (needed to run the Flyway CLI)"
  require_cmd curl       "install curl (used to download the Flyway CLI on first run)"
  require_cmd unzip      "install unzip (used to extract the Flyway CLI on first run)"
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

# Provision the Flyway Community Edition CLI for the migrate-live-flyway
# suite. Idempotent: skips download if .tools-live-tests/flyway-<version>
# already exists. Prepends the bin dir to PATH so the test subprocess
# finds `flyway`.
if [[ "$MODE" == "migrate" || "$MODE" == "all" ]]; then
  FLYWAY_HOME="$REPO_ROOT/.tools-live-tests/flyway-$FLYWAY_VERSION"
  if command -v flyway >/dev/null 2>&1; then
    green "  using flyway from $(command -v flyway) (pre-installed)"
  elif [[ -x "$FLYWAY_HOME/flyway" ]]; then
    green "  using flyway from $FLYWAY_HOME/flyway (cached)"
    export PATH="$FLYWAY_HOME:$PATH"
  else
    blue ""
    blue "==> Provisioning Flyway CLI $FLYWAY_VERSION at $FLYWAY_HOME (one-time setup)"
    mkdir -p "$REPO_ROOT/.tools-live-tests"
    ZIP="$REPO_ROOT/.tools-live-tests/flyway-commandline-$FLYWAY_VERSION.zip"
    # Maven Central base URL. Override via LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL
    # when running against a proxied / air-gapped env (e.g. Databricks-internal
    # Maven proxy – see the internal package-registry proxy setup doc).
    MAVEN_CENTRAL="${LAKEBASE_KIT_REGISTRY_MAVEN_CENTRAL:-https://repo1.maven.org/maven2}"
    URL="${MAVEN_CENTRAL%/}/org/flywaydb/flyway-commandline/$FLYWAY_VERSION/flyway-commandline-$FLYWAY_VERSION.zip"
    if [[ ! -f "$ZIP" ]]; then
      if ! curl --fail --silent --show-error --location -o "$ZIP" "$URL"; then
        red ""
        red "  Could not download Flyway from Maven Central ($URL)."
        yellow "  Workarounds:"
        yellow "    - Install Flyway manually (e.g. brew install flyway) and re-run."
        yellow "    - Pre-extract a Flyway tree at $FLYWAY_HOME with an executable flyway/ bin."
        exit 1
      fi
    fi
    unzip -q -d "$REPO_ROOT/.tools-live-tests" "$ZIP"
    rm -f "$ZIP"
    if [[ ! -x "$FLYWAY_HOME/flyway" ]]; then
      red "  flyway extracted but $FLYWAY_HOME/flyway is missing or not executable"
      exit 1
    fi
    green "  using flyway from $FLYWAY_HOME/flyway"
    export PATH="$FLYWAY_HOME:$PATH"
  fi
fi

# Build dist so the test fixtures import the latest compiled substrate.
blue ""
blue "==> Building dist/"
npm run build >/dev/null

if [[ "$MODE" == "migrate" || "$MODE" == "all" ]]; then
  yellow ""
  yellow "==> About to create Lakebase projects on your workspace"
  yellow "    workspace:    $DATABRICKS_HOST"
  yellow "    project names:"
  yellow "      migrate-7091-<timestamp>  (Alembic suite)"
  yellow "      migrate-7098-<timestamp>  (Flyway suite)"
  yellow "    cleanup:      automatic in each suite's afterAll() with 3-attempt retry"
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
    npx vitest run \
      tests/bdd/migrate-live.test.ts \
      tests/bdd/migrate-live-flyway.test.ts
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
