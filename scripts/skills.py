#!/usr/bin/env python3
"""
Generate and validate `manifest.json` from the `skills/` tree.

Mirror of `databricks/databricks-agent-skills/scripts/skills.py`. The
manifest is a machine-readable index of every skill + its files; it's
what a CLI installer (e.g., `databricks experimental aitools install`)
reads to know what to fetch.

Usage:
    python3 scripts/skills.py            # regenerate manifest.json
    python3 scripts/skills.py validate   # CI mode – exit 1 on drift

Skill discovery rule: any directory under `skills/` containing a
`SKILL.md` is a skill. Version comes from `SKILL.md` frontmatter's
`metadata.version`; description from the top-level `description` field.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = REPO_ROOT / "skills"
MANIFEST_PATH = REPO_ROOT / "manifest.json"
MANIFEST_VERSION = "2"  # matches dev-hub's manifest.json shape


def parse_skill_frontmatter(skill_md: Path) -> dict[str, Any]:
    """Pull `description`, `metadata.version`, and `experimental` from
    a SKILL.md's YAML frontmatter. Light-touch parser – only handles
    flat top-level keys + a one-level-deep `metadata:` block. Avoids a
    PyYAML dependency."""
    text = skill_md.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.+?)\n---", text, re.DOTALL)
    if not m:
        return {}
    body = m.group(1)

    info: dict[str, Any] = {}
    in_metadata = False
    for raw in body.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        # Track entry/exit of the metadata block.
        if raw.rstrip() == "metadata:":
            in_metadata = True
            continue
        if in_metadata and raw[:1] not in (" ", "\t"):
            in_metadata = False

        if in_metadata:
            sub = raw.strip()
            if ":" in sub:
                k, v = sub.split(":", 1)
                info.setdefault("metadata", {})[k.strip()] = _strip(v)
            continue

        if ":" in raw and raw[:1] not in (" ", "\t"):
            k, v = raw.split(":", 1)
            info[k.strip()] = _strip(v)
    return info


def _strip(v: str) -> str:
    v = v.strip()
    if v.startswith('"') and v.endswith('"'):
        return v[1:-1]
    if v.startswith("'") and v.endswith("'"):
        return v[1:-1]
    return v


def enumerate_skill_files(skill_dir: Path) -> list[str]:
    """Sorted relative paths of every file under the skill, excluding
    hidden files and editor backups."""
    files: list[str] = []
    for path in skill_dir.rglob("*"):
        if not path.is_file():
            continue
        if any(part.startswith(".") for part in path.relative_to(skill_dir).parts):
            continue
        if path.name.endswith("~") or path.name.endswith(".swp"):
            continue
        files.append(str(path.relative_to(skill_dir)))
    return sorted(files)


def build_manifest() -> dict[str, Any]:
    if not SKILLS_DIR.is_dir():
        raise SystemExit(f"skills/ directory not found at {SKILLS_DIR}")

    skills: dict[str, Any] = {}
    for skill_dir in sorted(p for p in SKILLS_DIR.iterdir() if p.is_dir()):
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            continue
        fm = parse_skill_frontmatter(skill_md)
        metadata = fm.get("metadata", {}) or {}
        skills[skill_dir.name] = {
            "version": metadata.get("version") or fm.get("version") or "0.0.0",
            "description": fm.get("description", ""),
            "experimental": str(metadata.get("experimental", "false")).lower() == "true",
            "updated_at": _iso_mtime(skill_md),
            "files": enumerate_skill_files(skill_dir),
        }

    return {
        "version": MANIFEST_VERSION,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "skills": skills,
    }


def _iso_mtime(path: Path) -> str:
    mt = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    return mt.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_manifest(manifest: dict[str, Any]) -> None:
    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {MANIFEST_PATH.relative_to(REPO_ROOT)} ({len(manifest['skills'])} skill(s)).")


def validate() -> int:
    """CI mode: regenerate in-memory and diff against the on-disk
    manifest, ignoring the always-fresh `updated_at` field at the
    top level."""
    if not MANIFEST_PATH.exists():
        print(f"::error::{MANIFEST_PATH.name} missing. Run `python3 scripts/skills.py`.")
        return 1
    actual = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected = build_manifest()

    # Ignore the top-level updated_at – it changes every run. Per-skill
    # updated_at IS compared (it's tied to SKILL.md mtime, which changes
    # only when the skill content is edited).
    actual.pop("updated_at", None)
    expected.pop("updated_at", None)
    if actual == expected:
        print("manifest.json is in sync with skills/.")
        return 0

    print("::error::manifest.json is out of sync with skills/. Run `python3 scripts/skills.py` and commit.")
    return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "validate":
        sys.exit(validate())
    write_manifest(build_manifest())
