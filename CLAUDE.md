# Claude Code instructions for `lakebase-app-dev-kit`

This repo is the Lakebase-backed application development kit. See [`README.md`](README.md) for the consumer-facing surface and [`CONTRIBUTING.md`](CONTRIBUTING.md) for maintainer docs.

## Standard project layout for kit-scaffolded projects

Every project created with `lakebase-create-project` gets two top-level scaffolds:

- **`scripts/`** — kit-provided substrate (consumed via git URL pin in the project's package.json).
- **`.tdd/`** — TDD workflow state read and written by `lakebase-tdd-workflows`. Layout: `features/<F>/`, `experiments/<F>/<exp>/`, `spikes/<slug>/`, `synthesis/<F>/`, `cycles/<F>/<S>/<AC>/`, `selection-log.md`, `smells.json`, `workflow-state.json`. See [`templates/tdd-bootstrap/.tdd/README.md`](templates/tdd-bootstrap/.tdd/README.md) for the canonical reference.

The `.tdd/` directory is created at scaffold time by `layDownTddScaffold()` in `scripts/lakebase/create-project.ts`. Pass `enableTdd: false` to opt out.

## When working in this repo

- Substrate scripts live in `scripts/<domain>/` (lakebase, github, git, tdd, util).
- Workflow-domain skills live in `skills/<domain>/SKILL.md`. Two kit-authored domains: `lakebase-scm-workflows`, `lakebase-release-workflows`, `lakebase-tdd-workflows`. One shared-canon skill: `software-design-principles`. Vendored devhub skills also live under `skills/`.
- Templates ship under `templates/`. Treat them as project assets — they end up in scaffolded projects, not in the substrate itself.
- BDD tests live in `tests/bdd/`. Hermetic by default; live tiers gate on `LAKEBASE_TEST_E2E=1` + `DATABRICKS_HOST`.

When editing scripts, always run `npm run typecheck` before committing. When adding skills or references under `skills/`, regenerate `manifest.json` via `python3 scripts/skills.py`.

## When proposing changes

Follow `lakebase-tdd-workflows` for TDD on Lakebase-paired projects: spec → architectural review → test list → design-spec gate → cycles. The Scrum-Master agent (`skills/lakebase-tdd-workflows/agents/scrum-master.md`) facilitates phase transitions and surfaces bad smells. Every gate is HITL.

For non-TDD work in this substrate repo itself, follow the conventions in [`CONTRIBUTING.md`](CONTRIBUTING.md): tier 1 hermetic tests required, tier 2 live tests for `scripts/lakebase/*` changes, single-seam credential rules enforced by CI grep guards.
