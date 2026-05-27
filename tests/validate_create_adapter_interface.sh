#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_adapter_interface (CREATE scripts/tdd/adapters/types.ts) ==="

echo "CHECK 1: Running validation command..."
if npm run typecheck; then
  echo "  PASS: typecheck clean"
else
  echo "  FAIL: typecheck clean"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
