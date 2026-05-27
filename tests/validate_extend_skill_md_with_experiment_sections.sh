#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: extend_skill_md_with_experiment_sections (MODIFY skills/lakebase-tdd-workflows/SKILL.md) ==="

echo "CHECK 1: Running validation command..."
if grep -q '## experiment' skills/lakebase-tdd-workflows/SKILL.md && grep -q 'design-spec-gate' skills/lakebase-tdd-workflows/SKILL.md; then
  echo "  PASS: SKILL.md mentions experiment + spike + design-spec-gate"
else
  echo "  FAIL: SKILL.md mentions experiment + spike + design-spec-gate"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
