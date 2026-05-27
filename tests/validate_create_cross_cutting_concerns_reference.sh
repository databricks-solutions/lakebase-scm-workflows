#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_cross_cutting_concerns_reference (CREATE skills/software-design-principles/references/cross-cutting-concerns.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/software-design-principles/references/cross-cutting-concerns.md && grep -q '^|' skills/software-design-principles/references/cross-cutting-concerns.md; then
  echo "  PASS: file exists AND contains a markdown table"
else
  echo "  FAIL: file exists AND contains a markdown table"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
