#!/usr/bin/env bash
# Git prepare-commit-msg hook: append schema diff (branch vs production) to the commit message
# so it appears in the editor when committing. Content is commented out (#) so it is visible
# but not part of the commit message unless you uncomment it.
# Install with: ./scripts/install-hook.sh

set -e
COMMIT_MSG_FILE="${1:?}"
# Add schema diff for normal commits and merge commits (skip squash only)
SOURCE="${2:-}"
if [ "$SOURCE" = "squash" ]; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT"

SCHEMA_DIFF="schema-diff.md"
# Refresh schema diff if we have Lakebase config and the script exists
if [ -f ".env" ] && [ -f "scripts/prepare-schema-diff.sh" ]; then
  set +e
  ./scripts/prepare-schema-diff.sh >/dev/null 2>&1
  set -e
fi

{
  echo ""
  echo "# --- Schema diff (this branch vs production) ---"
  echo "#"
  if [ -s "$SCHEMA_DIFF" ]; then
    while IFS= read -r line; do
      printf '# %s\n' "$line"
    done < "$SCHEMA_DIFF"
  else
    echo "# (No schema diff yet. Run: ./scripts/prepare-schema-diff.sh )"
    echo "# Then commit again to see the diff here, or leave as-is."
  fi
} >> "$COMMIT_MSG_FILE"
