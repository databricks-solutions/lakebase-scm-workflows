#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: bake_hard_rules_into_skill_md (MODIFY skills/lakebase-tdd-workflows/SKILL.md) ==="

echo "CHECK 1: Running validation command..."
if test $(grep -c '^[0-9]\.' skills/lakebase-tdd-workflows/SKILL.md) -ge 9; then
  echo "  PASS: SKILL.md contains all 9 numbered hard rules"
else
  echo "  FAIL: SKILL.md contains all 9 numbered hard rules"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
