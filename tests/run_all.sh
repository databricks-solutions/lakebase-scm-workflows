#!/bin/bash
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
FAILED=()
for script in "$TESTS_DIR"/validate_*.sh; do
  name=$(basename "$script" .sh)
  echo ""
  echo "--- Running: $name ---"
  if bash "$script"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$name")
  fi
done
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  echo "Failed:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All validations passed."
