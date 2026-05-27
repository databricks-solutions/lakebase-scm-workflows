#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_architect_reviewer_agent (CREATE skills/lakebase-tdd-workflows/agents/architect-reviewer.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/lakebase-tdd-workflows/agents/architect-reviewer.md && grep -q software-design-principles skills/lakebase-tdd-workflows/agents/architect-reviewer.md; then
  echo "  PASS: file exists AND references software-design-principles"
else
  echo "  FAIL: file exists AND references software-design-principles"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
