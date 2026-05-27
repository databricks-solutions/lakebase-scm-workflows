#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: update_root_claude_md (MODIFY CLAUDE.md) ==="

echo "CHECK 1: Running validation command..."
if grep -q '\.tdd/' CLAUDE.md; then
  echo "  PASS: CLAUDE.md mentions .tdd/"
else
  echo "  FAIL: CLAUDE.md mentions .tdd/"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
