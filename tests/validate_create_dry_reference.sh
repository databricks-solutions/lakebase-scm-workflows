#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_dry_reference (CREATE skills/software-design-principles/references/dry.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/software-design-principles/references/dry.md; then
  echo "  PASS: file exists"
else
  echo "  FAIL: file exists"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
