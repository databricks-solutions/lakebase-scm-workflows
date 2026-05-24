"""
Tests for scripts/openai-foundry.py.

Run with: python3 -m pytest tests/openai-foundry/ -v

These tests are pure-Python and exercise the generator's shape + the
validate subcommand. They depend on dist/apps/mcp-server/dump-tools.js
existing (built by `npm run build`).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
GEN_SCRIPT = REPO_ROOT / "scripts" / "openai-foundry.py"
OUTPUT_PATH = REPO_ROOT / "tools" / "openai-foundry" / "lakebase-scm-workflows.tools.json"
DUMP_BIN = REPO_ROOT / "dist" / "apps" / "mcp-server" / "dump-tools.js"


def _run_generator(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GEN_SCRIPT), *args],
        check=False,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def test_built_dump_bin_exists() -> None:
    """The generator depends on the built dump-tools helper."""
    assert DUMP_BIN.exists(), (
        f"{DUMP_BIN} missing. Run `npm install && npm run build` first."
    )


def test_generator_writes_output() -> None:
    """End-to-end: invoke the generator, expect a JSON file with our shape."""
    result = _run_generator()
    assert result.returncode == 0, result.stderr
    assert OUTPUT_PATH.exists()

    payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    assert payload["version"] == "1"
    assert "apps/mcp-server/tools.ts" in payload["source"]
    assert isinstance(payload["tools"], list)
    assert len(payload["tools"]) == 4


def test_each_tool_has_openai_function_shape() -> None:
    payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    expected_names = {
        "lakebase_get_connection",
        "lakebase_schema_diff",
        "lakebase_github_token",
        "lakebase_create_project",
    }
    actual_names = set()
    for tool in payload["tools"]:
        assert tool["type"] == "function"
        fn = tool["function"]
        assert isinstance(fn["name"], str)
        assert isinstance(fn["description"], str)
        assert fn["parameters"]["type"] == "object"
        assert "properties" in fn["parameters"]
        actual_names.add(fn["name"])
    assert actual_names == expected_names


def test_required_fields_preserved() -> None:
    """Required-field declarations survive the MCP→Foundry transform."""
    payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    by_name = {t["function"]["name"]: t for t in payload["tools"]}

    get_conn = by_name["lakebase_get_connection"]["function"]
    assert set(get_conn["parameters"]["required"]) == {"instance", "branch"}

    create_proj = by_name["lakebase_create_project"]["function"]
    assert set(create_proj["parameters"]["required"]) == {
        "projectName",
        "parentDir",
        "databricksHost",
    }


def test_validate_passes_on_fresh_output() -> None:
    """validate subcommand should pass right after a regenerate."""
    _run_generator()
    result = _run_generator("validate")
    assert result.returncode == 0, result.stderr
    assert "in sync" in result.stdout.lower()


def test_validate_fails_on_drift() -> None:
    """validate must flag when the on-disk JSON is stale."""
    _run_generator()
    original = OUTPUT_PATH.read_text(encoding="utf-8")
    try:
        payload = json.loads(original)
        payload["tools"][0]["function"]["description"] = "DRIFTED — should fail validate"
        OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

        result = _run_generator("validate")
        assert result.returncode == 1
        assert "out of sync" in result.stdout.lower() or "out of sync" in result.stderr.lower()
    finally:
        OUTPUT_PATH.write_text(original, encoding="utf-8")
