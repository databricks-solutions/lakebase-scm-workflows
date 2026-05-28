# Spec format

The on-disk `.tdd/` layout that the lakebase-tdd-workflows substrate reads and writes. Portable, tool-agnostic. Every structured element has both a markdown narrative (for humans) and a JSON contract (for agents, validation, and adapter sync).

## Directory layout

```
.tdd/
  spec.json                          ← top-level index (optional)
  spec.md                            ← top-level overview narrative (optional)
  workflow-state.json                ← current phase + locus (feature/story/ac/cycle/experiment)
  features/
    F1-partner-submits-assets/
      feature.md                     ← human-narrated description, design intent
      feature.json                   ← machine contract (see schemas/feature.schema.json)
      architecture.md                ← Architect Reviewer's layering + concerns summary (phase 1 output)
      test-list.md                   ← Beck-style ordered test list, human view
      test-list.json                 ← Beck-style ordered test list, machine contract
      stories/
        S1-submit-form/
          story.md                   ← user story prose
          story.json                 ← machine contract
          acs/
            AC1.md                   ← human-narrated AC
            AC1.json                 ← machine contract
            AC2.md
            AC2.json
          scenarios/
            s-1.feature              ← Gherkin (frontmatter ties to AC)
            s-1.test.ts              ← or runtime test stub
            s-2.feature
          test-list-per-ac.json      ← generated transform from feature test-list.json
  experiments/
    F1-partner-submits-assets/
      exp-1-postgres-arrays/
        notes.md                     ← strategy summary, learning
        branch.txt                   ← Lakebase branch id
        outcomes.json                ← {tests_passed, schema_diff_summary, code_diff_lines, status}
        timeline.json                ← cycles + smell triggers + HITL interventions
      exp-2-json-blob/
        ...
  spikes/
    F1-explore-storage/
      notes.md
      branch.txt
  synthesis/
    F1-partner-submits-assets/
      synthesis-2026-05-26.md        ← menu-pick decision + integration rules
      synthesized-spec/              ← renegotiated spec ready for fresh cycle (mirrors features/ shape)
  cycles/
    F1/S1/AC1/
      cycle-001.json                 ← {test, gate_check, navigator_verdict, driver_changes, timestamp}
      cycle-002.json
  selection-log.md                   ← append-only HITL gate decisions + rationale
  smells.json                        ← detected smells + resolutions
  adapters/
    jira.json                        ← optional per-adapter config
    markdown.json                    ← optional (markdown adapter is the default)
```

## The markdown ↔ JSON contract

**JSON is the source of truth for structured data**: ids, statuses, layer assignments, NFRs, links between features/stories/ACs.

**Markdown is the source of truth for narrative**: design intent, rationale, edge-case discussions, decision logs.

`scripts/tdd/spec-sync.ts` validates the pair:

- Schema: every `.json` is validated against its schema in `scripts/tdd/schemas/`. A schema failure is a hard error reported as a `DriftReport` of kind `schema`.
- Pair completeness: each `feature.json`, `story.json`, and `ac.json` must have a sibling `.md`. Missing narrative is reported as `pair-missing`. Empty narrative is reported as `narrative-empty` (size < 20 bytes).
- ID consistency: the directory name must start with the `id` field from the JSON. Mismatches are reported as `id-mismatch`.
- Drift is **warn-only**. The CLI exits 0 with reports printed. Auto-correction is intentionally not done – narrative changes are too easy to silently overwrite.

## Schemas (machine contract)

| Schema | Captures |
|---|---|
| `feature.schema.json` | id, name, status, tdd_mode, nfrs, success_metrics, stories, owner, external_ref |
| `story.schema.json` | id, asA, iWantTo, soThat, nfrs, acs, feature_id, external_ref |
| `ac.schema.json` | id, layer (API/E2E/Infra), given/when/then, scenarios, nfrs, architectural_notes, status, story_id, external_ref |
| `test-list.schema.json` | feature_id, ordered_for, items (id, description, ac_id, status, scenario_file) |
| `workflow-state.schema.json` | phase, feature_id, story_id, ac_id, cycle_id, experiment_id, timestamps |

Schemas live at `scripts/tdd/schemas/`. The substrate consumes them via Ajv in `spec-sync.ts`.

## Adapter sync

The on-disk format is canonical. Adapters (markdown, jira, github-issues, etc.) implement `SpecAdapter` from `scripts/tdd/adapters/types.ts` to mirror state to an external system. The `external_ref` field on every entity carries `{adapter, external_id}` once an adapter has pushed.

- **`markdown.ts`** – no-op (the spec IS the tracking). Default when no adapter is configured.
- **`jira.ts`** – stub at M1.5; full implementation deferred. When wired, will push features as Stories under an Epic, ACs as Sub-tasks, status as JIRA transitions.

## Read / write helpers

The substrate ships these helpers in `scripts/tdd/spec-sync.ts`:

- `readFeature(tddDir, featureId): Feature`
- `writeFeature(tddDir, feature): void`
- `readWorkflowState(tddDir): WorkflowState | null`
- `writeWorkflowState(tddDir, state): void`
- `validateSpec(tddDir): DriftReport[]`

CLI: `node scripts/tdd/spec-sync.ts <tddDir>` walks the tree and prints drift reports.

## Where this format does NOT go

- It does **not** carry execution telemetry. That lives in `cycles/<F>/<S>/<AC>/cycle-NNN.json` (per-cycle artifacts), `experiments/<F>/<exp>/timeline.json` (per-experiment), and `smells.json`.
- It does **not** carry CI / release state. That belongs to `lakebase-release-workflows`.
- It does **not** carry code or test source. Those live in the project tree, on the experiment branch.

The spec is what the workflow agrees on. The execution telemetry is what actually happened. Both matter; they live in different files for a reason.
