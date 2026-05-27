#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_spec_format_reference (CREATE skills/lakebase-tdd-workflows/references/spec-format.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/lakebase-tdd-workflows/references/spec-format.md; then
  echo "  PASS: file exists"
else
  echo "  FAIL: file exists"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
