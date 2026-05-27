#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: test_create_project_tdd_bootstrap (TEST tests/bdd/create-project-tdd-bootstrap.test.ts) ==="

echo "CHECK 1: Test file exists..."
if [ -f "tests/bdd/create-project-tdd-bootstrap.test.ts" ]; then
  echo "  PASS: test file exists"
else
  echo "  FAIL: test file not found at tests/bdd/create-project-tdd-bootstrap.test.ts"
  exit 1
fi

echo "CHECK 2: Test passes..."
if npx vitest run tests/bdd/create-project-tdd-bootstrap.test.ts; then
  echo "  PASS: test exited 0"
else
  echo "  FAIL: test exited non-zero"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
