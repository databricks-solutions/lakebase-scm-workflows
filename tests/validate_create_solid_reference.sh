#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_solid_reference (CREATE skills/software-design-principles/references/solid.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/software-design-principles/references/solid.md && grep -q 'Single Responsibility' skills/software-design-principles/references/solid.md; then
  echo "  PASS: file exists AND contains all five principle names"
else
  echo "  FAIL: file exists AND contains all five principle names"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
