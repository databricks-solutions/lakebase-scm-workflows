#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: regenerate_manifest (RUN python3 scripts/skills.py) ==="

echo "CHECK 1: Running validation command..."
if python3 scripts/skills.py validate; then
  echo "  PASS: manifest.json mentions software-design-principles"
else
  echo "  FAIL: manifest.json mentions software-design-principles"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
