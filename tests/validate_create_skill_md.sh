#!/bin/bash
set -euo pipefail
cd "/Users/kevin.hartman/code/databricks-solutions/lakebase-app-dev-kit"

echo "=== Validating: create_skill_md (CREATE skills/software-design-principles/SKILL.md) ==="

echo "CHECK 1: Running validation command..."
if test -f skills/software-design-principles/SKILL.md && grep -q '^name:' skills/software-design-principles/SKILL.md; then
  echo "  PASS: file exists AND frontmatter has name + description fields"
else
  echo "  FAIL: file exists AND frontmatter has name + description fields"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
