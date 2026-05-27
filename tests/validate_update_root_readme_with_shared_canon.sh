#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: update_root_readme_with_shared_canon (MODIFY README.md) ==="

echo "CHECK 1: Running validation command..."
if grep -q 'Shared canon' README.md && grep -q 'skills/software-design-principles/SKILL.md' README.md; then
  echo "  PASS: README contains Shared canon and links to skills/software-design-principles/SKILL.md"
else
  echo "  FAIL: README contains Shared canon and links to skills/software-design-principles/SKILL.md"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
