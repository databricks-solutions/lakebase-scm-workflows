#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_layered_architecture_reference (CREATE skills/software-design-principles/references/layered-architecture.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/software-design-principles/references/layered-architecture.md; then
  echo "  PASS: file exists"
else
  echo "  FAIL: file exists"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
