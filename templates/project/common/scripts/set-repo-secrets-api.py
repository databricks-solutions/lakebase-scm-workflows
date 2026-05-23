#!/usr/bin/env python3
"""
Set GitHub Actions repository secrets via the REST API.

Requires: PyNaCl, requests (or use venv with requirements in docs/github-secrets-api.md).

Usage:
  export GITHUB_TOKEN=ghp_...
  export DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
  export DATABRICKS_TOKEN=dapi...
  export LAKEBASE_PROJECT_ID=your_project_id
  python3 scripts/set-repo-secrets-api.py [OWNER/REPO]

If OWNER/REPO is omitted, uses the current git remote (origin) to infer the repo.
Secrets are read from the environment variables above.
"""

import base64
import json
import os
import subprocess
import sys
from typing import Tuple

from urllib.request import Request, urlopen
from urllib.error import HTTPError

try:
    from nacl import encoding, public
except ImportError:
    print("PyNaCl is required: pip install pynacl", file=sys.stderr)
    sys.exit(1)


def get_public_key(token: str, repo: str) -> Tuple[str, str]:
    url = f"https://api.github.com/repos/{repo}/actions/secrets/public-key"
    req = Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
    with urlopen(req) as r:
        data = json.loads(r.read().decode())
    return data["key_id"], data["key"]


def encrypt_secret(public_key_b64: str, secret_value: str) -> str:
    pub = public.PublicKey(public_key_b64.encode("utf-8"), encoding.Base64Encoder())
    box = public.SealedBox(pub)
    encrypted = box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def set_secret(token: str, repo: str, name: str, encrypted_value: str, key_id: str) -> None:
    url = f"https://api.github.com/repos/{repo}/actions/secrets/{name}"
    body = json.dumps({"encrypted_value": encrypted_value, "key_id": key_id}).encode()
    req = Request(url, data=body, method="PUT", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })
    with urlopen(req) as r:
        pass  # 204 or 201


def get_repo_from_git() -> str:
    out = subprocess.run(
        ["git", "config", "--get", "remote.origin.url"],
        capture_output=True, text=True, check=False
    )
    if out.returncode != 0 or not out.stdout.strip():
        return ""
    url = out.stdout.strip()
    # https://github.com/owner/repo or git@github.com:owner/repo.git
    if "github.com" in url:
        if url.startswith("git@"):
            path = url.split(":")[1].rstrip(".git")
        else:
            path = url.rstrip("/").split("github.com/")[-1].replace(".git", "")
        return path
    return ""


def main() -> int:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("Set GITHUB_TOKEN (e.g. a fine-grained or classic PAT with repo admin_secret).", file=sys.stderr)
        return 1

    repo = (sys.argv[1] if len(sys.argv) > 1 else "").strip() or get_repo_from_git()
    if not repo:
        print("Usage: set-repo-secrets-api.py [OWNER/REPO] (or run from a git repo with origin pointing to GitHub).", file=sys.stderr)
        return 1

    secrets = {
        "DATABRICKS_HOST": os.environ.get("DATABRICKS_HOST"),
        "DATABRICKS_TOKEN": os.environ.get("DATABRICKS_TOKEN"),
        "LAKEBASE_PROJECT_ID": os.environ.get("LAKEBASE_PROJECT_ID"),
    }
    missing = [k for k, v in secrets.items() if not v]
    if missing:
        print(f"Set these environment variables: {', '.join(missing)}", file=sys.stderr)
        return 1

    key_id, public_key = get_public_key(token, repo)
    for name, value in secrets.items():
        enc = encrypt_secret(public_key, value)
        set_secret(token, repo, name, enc, key_id)
        print(f"Set secret: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
