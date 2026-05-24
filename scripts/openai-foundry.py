#!/usr/bin/env python3
"""
Generate the OpenAI Foundry / Codex tool-spec layer for
lakebase-app-dev-kit.

We don't re-implement schemas here. The canonical surface lives in
apps/mcp-server/tools.ts; this script invokes the built `dump-tools`
helper (dist/apps/mcp-server/dump-tools.js), reads its JSON output,
and wraps each tool in the OpenAI Chat Completions function-tool
shape:

    {
      "type": "function",
      "function": {
        "name": "<tool>",
        "description": "<text>",
        "parameters": <JSON schema>
      }
    }

Output is committed at
tools/openai-foundry/lakebase-app-dev-kit.tools.json so it can be
pasted directly into a Foundry assistant or Codex tool config.

Usage:
    python3 scripts/openai-foundry.py             # regenerate the JSON
    python3 scripts/openai-foundry.py validate    # CI mode (exit 1 on drift)

Build dependency: dist/apps/mcp-server/dump-tools.js must exist –
run `npm run build` first (or invoke `npm prepare`, which the
`prepare` script in package.json runs after install).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DUMP_BIN = REPO_ROOT / "dist" / "apps" / "mcp-server" / "dump-tools.js"
OUTPUT_PATH = REPO_ROOT / "tools" / "openai-foundry" / "lakebase-app-dev-kit.tools.json"


def dump_tools() -> list[dict[str, Any]]:
    """Run the built dump-tools.js helper and parse its JSON output.
    Single source of truth: apps/mcp-server/tools.ts."""
    if not DUMP_BIN.exists():
        raise SystemExit(
            f"::error::{DUMP_BIN.relative_to(REPO_ROOT)} not found. "
            "Run `npm install && npm run build` first."
        )
    proc = subprocess.run(
        ["node", str(DUMP_BIN)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(proc.stdout)


def wrap_for_foundry(tool: dict[str, Any]) -> dict[str, Any]:
    """Wrap one tool definition in the OpenAI function-tool shape.

    Foundry expects `parameters` to be a JSON Schema; our MCP schemas
    are already valid JSON Schema, so this is a near-identity mapping
    with a name+description+parameters re-shape."""
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["inputSchema"],
        },
    }


def build_payload() -> dict[str, Any]:
    tools = dump_tools()
    return {
        "version": "1",
        "source": "apps/mcp-server/tools.ts (via dist/apps/mcp-server/dump-tools.js)",
        "tools": [wrap_for_foundry(t) for t in tools],
    }


def write_output(payload: dict[str, Any]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    n = len(payload["tools"])
    rel = OUTPUT_PATH.relative_to(REPO_ROOT)
    print(f"Wrote {rel} ({n} tool(s)).")


def validate() -> int:
    """CI mode: regenerate in-memory and compare against on-disk."""
    if not OUTPUT_PATH.exists():
        print(
            f"::error::{OUTPUT_PATH.name} missing. Run `python3 scripts/openai-foundry.py`."
        )
        return 1
    actual = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    expected = build_payload()
    if actual == expected:
        print(f"{OUTPUT_PATH.name} is in sync with apps/mcp-server/tools.ts.")
        return 0
    print(
        "::error::"
        f"{OUTPUT_PATH.relative_to(REPO_ROOT)} is out of sync with apps/mcp-server/tools.ts. "
        "Run `python3 scripts/openai-foundry.py` and commit."
    )
    return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "validate":
        sys.exit(validate())
    write_output(build_payload())
