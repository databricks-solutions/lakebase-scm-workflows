#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: update_root_readme_with_tdd_domains (MODIFY README.md) ==="

echo "CHECK 1: Running validation command..."
if grep -q 'skills/lakebase-tdd-workflows/SKILL.md' README.md && grep -q 'skills/software-design-principles/SKILL.md' README.md; then
  echo "  PASS: README.md links to both new skills"
else
  echo "  FAIL: README.md links to both new skills"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
