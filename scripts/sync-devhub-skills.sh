#!/usr/bin/env bash
# Re-pull the vendored devhub skills from databricks/devhub@main.
#
# The kit vendors `databricks-core` + `databricks-lakebase` from devhub's
# `.agents/skills/` so that kit consumers (lakebase-scm-extension, agent
# skills, scaffolded user projects) inherit a canonical Lakebase CLI
# reference without each having to clone devhub themselves.
#
# devhub is the authoritative source; this script syncs the local mirror.
# Run it whenever devhub publishes changes that affect Lakebase. Review
# the diff and land it in a focused PR; don't bundle other kit changes
# into a sync.
#
# Usage:
#   bash scripts/sync-devhub-skills.sh
#
# Requires: gh CLI authenticated, base64 in PATH.

set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEVHUB_REPO="databricks/devhub"
DEVHUB_REF="main"

declare -a SKILLS=(
  "databricks-core:SKILL.md"
  "databricks-core:data-exploration.md"
  "databricks-core:databricks-cli-auth.md"
  "databricks-core:databricks-cli-install.md"
  "databricks-core:declarative-automation-bundles.md"
  "databricks-lakebase:SKILL.md"
)

echo "Syncing devhub skills from ${DEVHUB_REPO}@${DEVHUB_REF}..."

for entry in "${SKILLS[@]}"; do
  IFS=':' read -r skill file <<< "$entry"
  target="skills/${skill}/${file}"
  mkdir -p "$(dirname "$target")"
  echo "  ${target}"
  gh api "repos/${DEVHUB_REPO}/contents/.agents/skills/${skill}/${file}?ref=${DEVHUB_REF}" \
    --jq .content | base64 -d > "$target"
done

echo ""
echo "Done. Review with: git diff skills/databricks-core skills/databricks-lakebase"
echo "If anything changed, commit in a focused PR titled '[devhub-sync] ...'."
