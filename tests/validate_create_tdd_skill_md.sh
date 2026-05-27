#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_tdd_skill_md (CREATE skills/lakebase-tdd-workflows/SKILL.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/lakebase-tdd-workflows/SKILL.md && grep -q '^name:' skills/lakebase-tdd-workflows/SKILL.md; then
  echo "  PASS: file exists AND frontmatter present"
else
  echo "  FAIL: file exists AND frontmatter present"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
