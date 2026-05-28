#!/usr/bin/env bash
# Run the kit's FULL test suite, including every env-gated live test,
# against a real Databricks workspace. One command, one project, all
# env vars set sensibly.
#
# Differs from scripts/run-live-tests.sh:
#   - Auto-resolves DATABRICKS_HOST from a `databricks` CLI profile.
#   - Provisions a fresh Lakebase project on demand (or accepts an
#     existing project id via --project).
#   - Sets every additional env var the kit's tests gate on
#     (LAKEBASE_TEST_INITIALIZR, PEER_DEP_INTEGRATION, the four
#     LAKEBASE_TEST_INSTANCE/BRANCH/PARENT/HOST identifiers, etc.).
#   - Defaults to NO TEARDOWN on failure (the kit's convention; failed
#     state must survive for inspection). Use --teardown to delete the
#     provisioned project after a green run.
#
# Usage:
#   scripts/run-all-live-tests.sh --profile <name>                       # auto-provision + full suite
#   scripts/run-all-live-tests.sh --profile <name> --project <id>        # reuse an existing project
#   scripts/run-all-live-tests.sh --profile <name> --teardown            # delete the project on green
#   scripts/run-all-live-tests.sh --profile <name> --no-prompt           # CI mode (skip grace period)
#   scripts/run-all-live-tests.sh --profile <name> \
#     --project-prefix smoke-ci- --grace-seconds 10 --database my_db     # fully parameterized invocation
#
# Required:
#   --profile <name>     A `databricks` CLI profile (from ~/.databrickscfg).
#                        DATABRICKS_HOST is auto-resolved via
#                        `databricks auth env --profile <name>`.
#
# Optional:
#   --project <id>             Use an existing Lakebase project (skips auto-provision).
#                              Default branch is auto-discovered via list-branches.
#   --branch <name>            Override LAKEBASE_TEST_BRANCH (default: project's default branch).
#   --parent <name>            Override LAKEBASE_TEST_PARENT (default: same as --branch).
#   --project-prefix <prefix>  Prefix for auto-provisioned project ids. Default: "live-all-".
#                              The full id becomes <prefix><unix-timestamp>.
#   --grace-seconds <n>        Seconds to wait before creating the project (Ctrl-C abort
#                              window). Default: 5. Use 0 + --no-prompt for CI.
#   --database <name>          LAKEBASE_TEST_DATABASE override. Default: unset, so the
#                              substrate falls back to DEFAULT_DATABASE (constants.ts).
#   --feature-ttl-days <n>     Override the kit's 30-day default feature branch TTL.
#                              Use on workspaces with a tighter maximum-expiration
#                              policy (e.g. --feature-ttl-days 7). Sets
#                              LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS for the run.
#   --teardown                 After a green run, delete the auto-provisioned project.
#                              No-op when --project was supplied.
#   --no-prompt                Skip the grace period entirely (for CI).
#   --help                     This help.
#
# What is NOT unlocked by this script:
#   - tests/integration/detect-language-via-self-hosted-runner.test.ts
#     (needs a self-hosted GitHub Actions runner registered).
#   - LAKEBASE_TEST_PROJECT_PATH-gated TDD live tests (need a Databricks
#     workspace path; deferred until the TDD scaffolder lands one).
#
# What this script gates on (substrate convention):
#   LAKEBASE_TEST_NO_TEARDOWN=1 is set by default. Failed runs leave the
#   project + branches in place. The user must explicitly pass --teardown
#   to enable post-run cleanup, and even then only on a fully-green run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

PROFILE=""
PROJECT_ID=""
BRANCH_OVERRIDE=""
PARENT_OVERRIDE=""
PROJECT_PREFIX="live-all-"
GRACE_SECONDS=5
DATABASE=""
FEATURE_TTL_DAYS=""
TEARDOWN_ON_GREEN=0
NO_PROMPT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)            PROFILE="$2"; shift 2 ;;
    --project)            PROJECT_ID="$2"; shift 2 ;;
    --branch)             BRANCH_OVERRIDE="$2"; shift 2 ;;
    --parent)             PARENT_OVERRIDE="$2"; shift 2 ;;
    --project-prefix)     PROJECT_PREFIX="$2"; shift 2 ;;
    --grace-seconds)      GRACE_SECONDS="$2"; shift 2 ;;
    --database)           DATABASE="$2"; shift 2 ;;
    --feature-ttl-days)   FEATURE_TTL_DAYS="$2"; shift 2 ;;
    --teardown)           TEARDOWN_ON_GREEN=1; shift ;;
    --no-prompt)          NO_PROMPT=1; shift ;;
    --help|-h)
      # `sed '$d'` drops the trailing `set -euo pipefail` line that closes
      # the range. Cross-platform: `head -n -1` is GNU-only (BSD head on
      # macOS errors with "illegal line count -- -1").
      sed -n '2,/^set -euo pipefail/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0
      ;;
    *)
      red "Unknown flag: $1"
      red "See $0 --help"
      exit 2
      ;;
  esac
done

if ! [[ "$GRACE_SECONDS" =~ ^[0-9]+$ ]]; then
  red "--grace-seconds must be a non-negative integer (got: $GRACE_SECONDS)"
  exit 2
fi

if [[ -n "$FEATURE_TTL_DAYS" ]] && ! [[ "$FEATURE_TTL_DAYS" =~ ^[0-9]+$ ]]; then
  red "--feature-ttl-days must be a positive integer (got: $FEATURE_TTL_DAYS)"
  exit 2
fi

if [[ -z "$PROFILE" ]]; then
  red "--profile is required."
  red "See $0 --help"
  exit 2
fi

blue "==> Resolving workspace host from profile '$PROFILE'"
if ! command -v databricks >/dev/null 2>&1; then
  red "  databricks CLI not on PATH"
  red "  install: https://docs.databricks.com/dev-tools/cli/install.html"
  exit 1
fi

RAW_AUTH_ENV="$(databricks auth env --profile "$PROFILE" 2>&1 || true)"
DATABRICKS_HOST="$(printf '%s\n' "$RAW_AUTH_ENV" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  host = (d.get('env') or {}).get('DATABRICKS_HOST', '').rstrip('/')
  print(host)
except Exception:
  print('')
")"

if [[ -z "$DATABRICKS_HOST" ]]; then
  red "  Could not resolve DATABRICKS_HOST from profile '$PROFILE'."
  red "  Try: databricks auth login --profile $PROFILE"
  exit 1
fi
green "  DATABRICKS_HOST = $DATABRICKS_HOST"
export DATABRICKS_HOST
export DATABRICKS_CONFIG_PROFILE="$PROFILE"

# Token freshness reminder. OAuth tokens from `databricks auth login` rotate
# silently; PAT-based profiles stay until revoked. The 60-second sanity probe
# below catches expired tokens before we attempt destructive ops.
blue "==> Auth sanity check (current-user me)"
if ! databricks current-user me --profile "$PROFILE" -o json >/dev/null 2>&1; then
  red "  Auth probe failed. Token may be expired."
  red "  Try: databricks auth login --profile $PROFILE"
  exit 1
fi
green "  auth OK"

# Resolve or provision the Lakebase project.
PROVISIONED=0
if [[ -n "$PROJECT_ID" ]]; then
  blue ""
  blue "==> Using existing Lakebase project: $PROJECT_ID"
  if ! databricks postgres get-project "projects/$PROJECT_ID" --profile "$PROFILE" -o json >/dev/null 2>&1; then
    red "  Project '$PROJECT_ID' not found on $DATABRICKS_HOST"
    exit 1
  fi
  green "  project exists, READY"
else
  PROJECT_ID="${PROJECT_PREFIX}$(date +%s)"
  yellow ""
  yellow "==> About to create a fresh Lakebase project"
  yellow "    workspace:  $DATABRICKS_HOST"
  yellow "    project:    $PROJECT_ID  (NEW)"
  yellow "    teardown:   $( [[ $TEARDOWN_ON_GREEN == 1 ]] && echo 'on green run' || echo 'DISABLED – manual cleanup required at end' )"
  yellow ""
  if [[ "$NO_PROMPT" != "1" ]]; then
    yellow "    Press Ctrl-C in the next ${GRACE_SECONDS} seconds to abort. Pass --no-prompt to skip in CI, or --grace-seconds to tune."
    sleep "$GRACE_SECONDS"
  fi
  blue "==> Creating Lakebase project $PROJECT_ID (long-running, ~30s)"
  databricks postgres create-project "$PROJECT_ID" --profile "$PROFILE" -o json >/dev/null
  PROVISIONED=1
  green "  created: $PROJECT_ID"
fi

# Resolve the default branch name (leaf of name, never uid – see
# scripts/lakebase/branch-id.ts for the rationale).
DEFAULT_BRANCH="$(databricks postgres list-branches "projects/$PROJECT_ID" --profile "$PROFILE" -o json 2>&1 | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  items = d if isinstance(d, list) else d.get('branches') or d.get('items') or []
  for b in items:
    if (b.get('status') or {}).get('default') or b.get('is_default'):
      name = b.get('name', '')
      print(name.split('/branches/')[-1] if '/branches/' in name else '')
      break
except Exception:
  pass
")"

if [[ -z "$DEFAULT_BRANCH" ]]; then
  red "  Could not resolve default branch for project $PROJECT_ID"
  exit 1
fi
green "  default branch (leaf, not uid): $DEFAULT_BRANCH"

BRANCH="${BRANCH_OVERRIDE:-$DEFAULT_BRANCH}"
PARENT="${PARENT_OVERRIDE:-$BRANCH}"

# Export everything every env-gated test in the kit looks at. The list was
# derived by greping process.env.* across tests/. Each block notes which
# tests are unlocked.
blue ""
blue "==> Exporting env vars"
export LAKEBASE_TEST_E2E=1
export LAKEBASE_TEST_INSTANCE="$PROJECT_ID"
export LAKEBASE_TEST_BRANCH="$BRANCH"
export LAKEBASE_TEST_PARENT="$PARENT"
export LAKEBASE_TEST_HOST="$DATABRICKS_HOST"
export LAKEBASE_TEST_PROFILE="$PROFILE"
# Optional fields: only set when the user provides them. Tests have
# sensible defaults if absent.
export LAKEBASE_TEST_COMPARISON_BRANCH="${LAKEBASE_TEST_COMPARISON_BRANCH:-$BRANCH}"
# LAKEBASE_TEST_DATABASE: explicit --database flag wins; otherwise leave
# whatever the caller's env already has (which may itself be unset).
# When unset, the substrate falls back to DEFAULT_DATABASE
# (scripts/lakebase/constants.ts) – single source of truth, no duplication.
if [[ -n "$DATABASE" ]]; then
  export LAKEBASE_TEST_DATABASE="$DATABASE"
fi

# LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS: explicit --feature-ttl-days flag wins.
# Workspaces with maximum-expiration policies tighter than 30 days (the
# kit's default) need this for cutExperiment / createFeatureBranch /
# tdd-synthesis paths. We compute ms = days * 86_400_000 here so the
# substrate's existing convention defaults pick it up.
if [[ -n "$FEATURE_TTL_DAYS" ]]; then
  export LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS="$(( FEATURE_TTL_DAYS * 86_400_000 ))"
  green "  LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS=$LAKEBASE_KIT_FEATURE_BRANCH_TTL_MS  (${FEATURE_TTL_DAYS}d)"
fi
# Unlock the live Initializr fetch + the MCP peer-dep integration check.
# Both are network/integration-side and the gate is just a "yes please".
export LAKEBASE_TEST_INITIALIZR=1
export PEER_DEP_INTEGRATION=1
# Substrate convention: failed live runs MUST leave the project + branches
# in place so the user can inspect. Only --teardown switches this off, and
# even then only after a fully-green run.
export LAKEBASE_TEST_NO_TEARDOWN=1

green "  LAKEBASE_TEST_INSTANCE=$LAKEBASE_TEST_INSTANCE"
green "  LAKEBASE_TEST_BRANCH=$LAKEBASE_TEST_BRANCH  LAKEBASE_TEST_PARENT=$LAKEBASE_TEST_PARENT"
green "  LAKEBASE_TEST_E2E=1  LAKEBASE_TEST_INITIALIZR=1  PEER_DEP_INTEGRATION=1"
green "  LAKEBASE_TEST_NO_TEARDOWN=1  (per substrate convention)"

# Build dist so the integration tests import the latest compiled substrate.
blue ""
blue "==> Building dist/"
npm run build >/dev/null
green "  dist ready"

# Run the full suite. vitest discovers every test; the env above unlocks
# each gated describe block.
blue ""
blue "==> Running full suite (vitest, every gated describe unlocked)"
RUN_STATUS=0
npx vitest run 2>&1 | tee /tmp/run-all-live-tests.out || RUN_STATUS=$?

green ""
green "==> Run complete (exit $RUN_STATUS)"
SKIP_COUNT="$(grep -oE 'Tests +[0-9]+ passed.*[0-9]+ skipped' /tmp/run-all-live-tests.out | tail -1 || true)"
[[ -n "$SKIP_COUNT" ]] && yellow "  $SKIP_COUNT"

if [[ "$RUN_STATUS" -eq 0 && "$TEARDOWN_ON_GREEN" -eq 1 && "$PROVISIONED" -eq 1 ]]; then
  yellow ""
  yellow "==> Green run + --teardown specified. Deleting $PROJECT_ID..."
  if databricks postgres delete-project "projects/$PROJECT_ID" --profile "$PROFILE" 2>&1 | tail -3; then
    green "  deleted $PROJECT_ID"
  else
    red "  delete failed; manual cleanup needed:"
    red "    databricks postgres delete-project projects/$PROJECT_ID --profile $PROFILE"
  fi
elif [[ "$PROVISIONED" -eq 1 ]]; then
  yellow ""
  yellow "==> Project preserved (per never-teardown-on-failure convention):"
  yellow "    project:    $PROJECT_ID"
  yellow "    workspace:  $DATABRICKS_HOST"
  yellow "    cleanup:    databricks postgres delete-project projects/$PROJECT_ID --profile $PROFILE"
fi

exit "$RUN_STATUS"
