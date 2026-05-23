#!/usr/bin/env bash
# Post-merge hook: clean up Lakebase branches and prune stale git refs after merge to main.
#
# Triggered automatically after `git merge` or `git pull` that includes a merge.
# Also called by the dev-loop orchestrator after `gh pr merge`.
#
# Install: ./scripts/install-hook.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Only run on main branch
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  exit 0
fi

# Load .env for LAKEBASE_PROJECT_ID
if [ -f .env ]; then
  set -a; source .env 2>/dev/null || true; set +a
fi

# Clean up Lakebase branches from the merged PR
# Extract PR number from the most recent merge commit message (e.g., "... (#21)")
PR_NUM="$(git log -1 --pretty=%s | grep -oE '#[0-9]+' | tail -1 | tr -d '#')"
# Extract feature branch name from the squash commit (e.g., "F16 ... from feature/org-model")
FEATURE_BRANCH="$(git log -1 --pretty=%b | grep -oE 'from [^ ]+' | head -1 | sed 's/from //' | sed 's/\//-/g' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-63)"

if [ -n "$PR_NUM" ] || [ -n "$FEATURE_BRANCH" ]; then
  ARGS=""
  [ -n "$PR_NUM" ] && ARGS="ci-pr-${PR_NUM}"
  [ -n "$FEATURE_BRANCH" ] && ARGS="${ARGS:+$ARGS }${FEATURE_BRANCH}"
  if [ -n "$ARGS" ] && [ -x "$SCRIPT_DIR/delete-lakebase-branches.sh" ]; then
    echo "Post-merge: cleaning up Lakebase branches: $ARGS"
    "$SCRIPT_DIR/delete-lakebase-branches.sh" $ARGS 2>/dev/null || true
  fi
fi

# Prune stale remote tracking refs
git remote prune origin 2>/dev/null && echo "Post-merge: pruned stale remote refs." || true

# Delete local branches whose remote tracking branch is gone (squash merges need -D)
git branch -vv 2>/dev/null | grep ': gone]' | awk '{print $1}' | while read branch; do
  [ "$branch" = "main" ] || [ "$branch" = "master" ] && continue
  git branch -D "$branch" 2>/dev/null && echo "Post-merge: deleted local branch $branch" || true
done
