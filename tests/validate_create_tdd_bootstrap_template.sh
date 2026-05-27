#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_tdd_bootstrap_template (CREATE templates/tdd-bootstrap/.tdd/README.md) ==="

echo "CHECK 1: Running validation command..."
if test -f templates/tdd-bootstrap/.tdd/README.md && test -f templates/tdd-bootstrap/.tdd/spec.json; then
  echo "  PASS: skeleton present"
else
  echo "  FAIL: skeleton present"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
