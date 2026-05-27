#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: regenerate_manifest_final (RUN python3 scripts/skills.py) ==="

echo "CHECK 1: Running validation command..."
if python3 scripts/skills.py validate; then
  echo "  PASS: skills.py validate succeeds"
else
  echo "  FAIL: skills.py validate succeeds"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
