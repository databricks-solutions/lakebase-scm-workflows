#!/usr/bin/env bash
# Post-merge hook: clean up Lakebase branches and prune stale git refs after merge to main.
#
# Triggered automatically after `git merge` or `git pull` that includes a merge.
# Also called by the dev-loop orchestrator after `gh pr merge`.
#
# Install: ./scripts/install-hook.sh

set -e
# Resolve the repo root via git, not via BASH_SOURCE/.., so this works both
# when invoked directly from scripts/ (as during local testing) and when
# installed at .git/hooks/post-merge by installHooks (as in production).
# The BASH_SOURCE/.. heuristic resolves to .git/ in the installed case,
# which made every helper-script lookup below fail silently.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
HELPERS_DIR="$REPO_ROOT/scripts"

# Only run on main branch
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  exit 0
fi

# Load .env for LAKEBASE_PROJECT_ID
if [ -f .env ]; then
  set -a; source .env 2>/dev/null || true; set +a
fi

# Clean up Lakebase branches from the merged PR.
#
# PR number comes from the squash commit subject (e.g. "... (#21)"). This is
# deterministic across gh's default squash format.
#
# Feature branch comes from `gh pr view <PR_NUM> --json headRefName`, the
# authoritative source. The previous implementation grepped the commit body
# for "from <branch>", which (a) doesn't exist in default gh squash bodies
# and (b) matched arbitrary "from X" text including content added by our own
# prepare-commit-msg.sh schema-diff template (e.g. "could not be resolved
# from Lakebase"). The gh-based lookup is unambiguous; when gh is unavailable
# or the lookup fails, we cleanly skip feature-branch cleanup rather than
# guessing.
PR_NUM="$(git log -1 --pretty=%s | grep -oE '#[0-9]+' | tail -1 | tr -d '#')"
FEATURE_BRANCH=""
if [ -n "$PR_NUM" ] && command -v gh >/dev/null 2>&1; then
  HEAD_REF="$(gh pr view "$PR_NUM" --json headRefName --jq .headRefName 2>/dev/null)" || true
  if [ -n "$HEAD_REF" ] && [ -x "$HELPERS_DIR/sanitize-branch-name.sh" ]; then
    FEATURE_BRANCH="$("$HELPERS_DIR/sanitize-branch-name.sh" "$HEAD_REF")"
  fi
fi

if [ -n "$PR_NUM" ] || [ -n "$FEATURE_BRANCH" ]; then
  ARGS=""
  [ -n "$PR_NUM" ] && ARGS="ci-pr-${PR_NUM}"
  [ -n "$FEATURE_BRANCH" ] && ARGS="${ARGS:+$ARGS }${FEATURE_BRANCH}"
  if [ -n "$ARGS" ] && [ -x "$HELPERS_DIR/delete-lakebase-branches.sh" ]; then
    echo "Post-merge: cleaning up Lakebase branches: $ARGS"
    "$HELPERS_DIR/delete-lakebase-branches.sh" $ARGS 2>/dev/null || true
  fi
fi

# Prune stale remote tracking refs
git remote prune origin 2>/dev/null && echo "Post-merge: pruned stale remote refs." || true

# Delete local branches whose remote tracking branch is gone (squash merges need -D)
git branch -vv 2>/dev/null | grep ': gone]' | awk '{print $1}' | while read branch; do
  [ "$branch" = "main" ] || [ "$branch" = "master" ] && continue
  git branch -D "$branch" 2>/dev/null && echo "Post-merge: deleted local branch $branch" || true
done
