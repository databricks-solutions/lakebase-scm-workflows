#!/usr/bin/env bash
# Sanitize a git branch name into a Lakebase-compatible branch ID.
#
# Rules:
#   - Lowercase only
#   - Replace / with -
#   - Strip non-alphanumeric characters (except -)
#   - Truncate to 63 characters
#   - Pad to minimum 3 characters
#
# Usage:
#   ./scripts/sanitize-branch-name.sh "feature/My-Branch_Name"
#   # Output: feature-my-branch-name
#
#   SANITIZED=$(./scripts/sanitize-branch-name.sh "$GIT_BRANCH")

INPUT="${1:?Usage: sanitize-branch-name.sh <git-branch-name>}"

SANITIZED="$(echo "$INPUT" | sed 's/\//-/g' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-63)"

# Lakebase requires at least 3 characters
while [ ${#SANITIZED} -lt 3 ]; do SANITIZED="${SANITIZED}-x"; done

echo "$SANITIZED"
