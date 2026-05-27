#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_scrum_master_agent (CREATE skills/lakebase-tdd-workflows/agents/scrum-master.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/lakebase-tdd-workflows/agents/scrum-master.md; then
  echo "  PASS: file exists"
else
  echo "  FAIL: file exists"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
