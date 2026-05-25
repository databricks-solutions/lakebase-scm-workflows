#!/usr/bin/env bash
# Install Git hooks: post-checkout (Lakebase branch), prepare-commit-msg (schema diff), pre-push (repo secrets).
# Run from repo root: ./scripts/install-hook.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK="$REPO_ROOT/.git/hooks/post-checkout"

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "Not a git repo root: $REPO_ROOT"
  exit 1
fi

# Pin core.hooksPath to this project's .git/hooks. Without this, a globally
# configured core.hooksPath (common in monorepo orgs that ship a corporate
# pre-commit secret scanner via ~/.databricks/githooks or similar) makes
# git skip .git/hooks entirely - our Lakebase hooks would be installed but
# never fire. Project-local config takes precedence over global, so this
# guarantees the hooks below are the ones git invokes.
git -C "$REPO_ROOT" config --local core.hooksPath .git/hooks

cp "$SCRIPT_DIR/post-checkout.sh" "$HOOK"
chmod +x "$HOOK"
echo "Installed $HOOK (post-checkout). For Lakebase: set LAKEBASE_PROJECT_ID and Databricks auth in .env."

if [ -f "$SCRIPT_DIR/prepare-commit-msg.sh" ]; then
  cp "$SCRIPT_DIR/prepare-commit-msg.sh" "$REPO_ROOT/.git/hooks/prepare-commit-msg"
  chmod +x "$REPO_ROOT/.git/hooks/prepare-commit-msg"
  echo "Installed .git/hooks/prepare-commit-msg (appends schema diff to commit message template)."
fi

if [ -f "$SCRIPT_DIR/pre-push.sh" ]; then
  cp "$SCRIPT_DIR/pre-push.sh" "$REPO_ROOT/.git/hooks/pre-push"
  chmod +x "$REPO_ROOT/.git/hooks/pre-push"
  echo "Installed .git/hooks/pre-push (refreshes OAuth token + syncs secrets before push)."
fi

if [ -f "$SCRIPT_DIR/post-merge.sh" ]; then
  cp "$SCRIPT_DIR/post-merge.sh" "$REPO_ROOT/.git/hooks/post-merge"
  chmod +x "$REPO_ROOT/.git/hooks/post-merge"
  echo "Installed .git/hooks/post-merge (cleans up Lakebase branches + prunes stale refs after merge)."
fi

echo "After any change to hook scripts in scripts/, run this again so .git/hooks uses the latest."
