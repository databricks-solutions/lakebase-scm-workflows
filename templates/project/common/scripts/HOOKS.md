# Git hooks installed by this project

This project ships four git hooks that keep the Lakebase branch and the
git branch in sync. They are installed into `.git/hooks/` by
`scripts/install-hook.sh` at scaffold time (and by the extension's
"Install hooks" command if the repo is opened later).

## The four hooks

| Hook | When it fires | What it does |
|---|---|---|
| `post-checkout` | After `git checkout` (branch or paths) | Creates a paired Lakebase branch if one doesn't exist for this git branch, then refreshes `.env`'s `LAKEBASE_BRANCH_ID` + connection credentials. |
| `prepare-commit-msg` | After staging, before the editor opens | Reads the latest `.tmp/schema-diff.md` and embeds it in the commit body so reviewers see DDL changes inline. |
| `pre-push` | Before `git push` | Refreshes the Databricks OAuth token and syncs the three CI secrets (`DATABRICKS_HOST`, `LAKEBASE_PROJECT_ID`, `DATABRICKS_TOKEN`) to the GitHub repo so PR workflows have what they need. |
| `post-merge` | After `git merge` or `git pull` | Deletes the `ci-pr-<N>` Lakebase branch that paired this PR, and fast-forwards the source tier to the merge target so the next release flows cleanly. |

## Why this project pins `core.hooksPath`

`scripts/install-hook.sh` (and the substrate's `installHooks` routine
that scaffold-time uses) does this immediately after copying the hook
files into `.git/hooks/`:

```bash
git -C "$REPO_ROOT" config --local core.hooksPath .git/hooks
```

The pin exists because many Databricks contributors run a globally
configured `core.hooksPath` (commonly `~/.databricks/githooks/`) that
ships a corporate pre-commit secret scanner. With that global pointer
in place, git skips `.git/hooks/` entirely, meaning the Lakebase hooks
we just installed would never fire. Project-local config takes
precedence over global, so the pin guarantees the hooks this project
just installed are the ones git invokes.

### Trade-off: the corporate global hook stops firing in this project

If you relied on the corporate hook (e.g. for secret scanning), it
will no longer run in this project after the pin. Two ways to bring
it back without losing the Lakebase hooks:

**Option 1: copy the corporate hook into `.git/hooks/`.** Run it before
the Lakebase logic in the same file:

```bash
# example: .git/hooks/pre-commit
#!/usr/bin/env sh
set -e

# Run corporate secret scanner first
if [ -x "$HOME/.databricks/githooks/pre-commit" ]; then
  "$HOME/.databricks/githooks/pre-commit" "$@"
fi

# Continue with this project's pre-commit logic (if any)
```

**Option 2: chain inside the project's hook script.** Each Lakebase
hook (`post-checkout.sh`, `prepare-commit-msg.sh`, `pre-push.sh`,
`post-merge.sh`) is a plain shell script — add a leading block that
invokes the corporate hook of the same name, then falls through to
the Lakebase logic. This keeps the canonical version in
`scripts/*.sh` (the source-of-truth that survives reinstalls).

### Verifying which hooks are active

```bash
# Should print `.git/hooks`
git config --local core.hooksPath

# Should list post-checkout, prepare-commit-msg, pre-push, post-merge
ls .git/hooks/
```

If `core.hooksPath` is empty or points elsewhere and the Lakebase
hooks aren't firing, run `bash scripts/install-hook.sh` (or use the
extension's "Install hooks" command) to re-pin.
