#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: extend_create_project_to_lay_down_tdd (MODIFY scripts/lakebase/create-project.ts) ==="

echo "CHECK 1: Running validation command..."
if npm run typecheck; then
  echo "  PASS: typecheck clean"
else
  echo "  FAIL: typecheck clean"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
