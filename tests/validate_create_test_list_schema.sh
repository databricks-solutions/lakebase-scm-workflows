#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_test_list_schema (CREATE scripts/tdd/schemas/test-list.schema.json) ==="

echo "CHECK 1: Running validation command..."
if node -e "JSON.parse(require('fs').readFileSync('scripts/tdd/schemas/test-list.schema.json','utf8'))"; then
  echo "  PASS: file is valid JSON Schema"
else
  echo "  FAIL: file is valid JSON Schema"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
