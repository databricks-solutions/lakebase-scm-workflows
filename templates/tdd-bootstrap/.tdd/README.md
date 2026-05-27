# .tdd/

This directory is the canonical home for this project's TDD workflow state. It is read and written by `lakebase-tdd-workflows` (`skills/lakebase-tdd-workflows/`).

## Layout

- `spec.{md,json}` — top-level overview (optional).
- `workflow-state.json` — current phase + locus (feature / story / AC / cycle / experiment).
- `features/<F>/` — one directory per feature. Contains `feature.{md,json}`, `architecture.md` (added by Architect Reviewer), `test-list.{md,json}`, `stories/<S>/...`.
- `experiments/<F>/<exp>/` — one directory per experiment branch with `notes.md`, `branch.txt`, `outcomes.json`, `timeline.json`.
- `spikes/<slug>/` — throwaway exploration. Notes preserved after branch teardown.
- `synthesis/<F>/` — N>=2 menu-pick decision records + `synthesized-spec/` subtree.
- `cycles/<F>/<S>/<AC>/cycle-NNN.json` — per-cycle RED/GREEN/REFACTOR artifacts.
- `selection-log.md` — append-only HITL gate decisions + rationale.
- `smells.json` — detected bad smells + remediations.
- `adapters/<adapter>.json` — optional per-adapter config (JIRA, GitHub Issues, etc.).

## Getting started

1. Read [`skills/lakebase-tdd-workflows/SKILL.md`](../../../../skills/lakebase-tdd-workflows/SKILL.md) (or open via your agent's installed copy of the skill).
2. Author a draft spec under `features/<F>/` using the schemas in `scripts/tdd/schemas/`.
3. Get the Product Owner to sign off (Gate 1) before invoking the Architect Reviewer.
4. The Scrum-Master agent (`skills/lakebase-tdd-workflows/agents/scrum-master.md`) facilitates the rest of the phases.

JSON files are validated against `scripts/tdd/schemas/` by `scripts/tdd/spec-sync.ts`. Drift is warned, not auto-corrected.
