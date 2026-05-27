# feature-status JSON schema

The stable JSON payload emitted by `lakebase-feature-status <featureId> --json` and the equivalent `getFeatureStatus()` module export. This shape is part of the substrate's public contract: agents and MCP consumers depend on it.

**Backwards-compatibility contract.** Top-level keys are append-only. Nested object keys are append-only. Field types do not change. Removing or renaming a key requires a major version bump.

## Top-level shape

```ts
interface FeatureStatusSnapshot {
  feature_id: string;
  current_workflow_phase: string | null;
  current_workflow_pointer: WorkflowPointer | null;
  plan: ExperimentPlan | null;
  test_list: TestListSummary | null;
  experiments: ExperimentStatusEntry[];
  selection_log_recent: SelectionLogEntry[];
  open_smells: SmellHit[];
}
```

| Field | Type | Meaning |
|---|---|---|
| `feature_id` | string | Echo of the queried feature id. |
| `current_workflow_phase` | string \| null | Phase from `.tdd/workflow-state.json` (`discovery` / `architectural-review` / `test-list-construction` / `design-spec-gate` / `implementation` / `synthesis` / `review` / `shipped` / `abandoned`). `null` when `workflow-state.json` is missing. |
| `current_workflow_pointer` | object \| null | Active workflow locus (feature/story/ac/cycle/experiment ids). `null` when `workflow-state.json` is missing. The pointer's `feature_id` may differ from the queried `feature_id` (the workflow may be focused elsewhere). |
| `plan` | object \| null | Approved experiment plan from `.tdd/features/<F>/plan.json`. `null` until the design-spec gate is approved. |
| `test_list` | object \| null | Aggregated counts from `.tdd/features/<F>/test-list.json`. `null` when the test list has not been authored yet. |
| `experiments` | array | One entry per directory under `.tdd/experiments/<F>/`. Empty when no experiments have been cut. |
| `selection_log_recent` | array | Up to the last 5 entries from `.tdd/selection-log.md`, oldest-first. |
| `open_smells` | array | Unresolved entries from `.tdd/smells.json` (entries with no `resolution` field). Global to the `.tdd/` tree; not filtered per feature in this version. |

## Nested types

### WorkflowPointer

```ts
interface WorkflowPointer {
  feature_id: string | null;
  story_id: string | null;
  ac_id: string | null;
  cycle_id: string | null;
  experiment_id: string | null;
}
```

### ExperimentPlan

See `scripts/tdd/design-spec-gate.ts`. Persisted at `.tdd/features/<F>/plan.json`.

```ts
interface ExperimentPlan {
  feature_id: string;
  N: number;
  mode: "N=1" | "N>=2";
  strategies: Array<{ name: string; rationale: string }>;
  budget: {
    concurrent_branches: number;
    wall_clock_minutes: number;
    agent_pairs: number;
  };
  rationale: string;
}
```

### TestListSummary

```ts
interface TestListSummary {
  total: number;
  by_status: {
    pending: number;
    red: number;
    green: number;
    refactored: number;
    skipped: number;
  };
  completion_pct: number;  // (green + refactored) / total, rounded to nearest integer; 0 when total === 0
}
```

### ExperimentStatusEntry

```ts
interface ExperimentStatusEntry {
  slug: string;
  branch_id: string;
  status: "running" | "succeeded" | "failed" | "abandoned" | null;
  tests_passed: number | null;
  tests_failed: number | null;
  schema_diff_summary: string | null;
  cycle_count: number;  // count of entries in timeline.json
}
```

### SelectionLogEntry

```ts
interface SelectionLogEntry {
  timestamp: string;  // ISO 8601, as parsed from the `## <ISO> — <title>` heading
  title: string;
}
```

### SmellHit

See `scripts/tdd/smells.ts`. Each open smell entry also carries `detected_at: string` from the on-disk log.

```ts
interface SmellHit {
  smell: string;       // one of the names from SMELL_CATALOG (e.g. "cycle-stall", "fragility-ratio")
  cycle_ids: string[];
  detail: string;
  detected_at: string; // ISO 8601
  // resolution field is absent for open smells (filtered out if present)
}
```

## Example payload

```json
{
  "feature_id": "F1-checkout",
  "current_workflow_phase": "implementation",
  "current_workflow_pointer": {
    "feature_id": "F1-checkout",
    "story_id": null,
    "ac_id": null,
    "cycle_id": "C1",
    "experiment_id": null
  },
  "plan": {
    "feature_id": "F1-checkout",
    "N": 1,
    "mode": "N=1",
    "strategies": [{ "name": "checkout", "rationale": "default" }],
    "budget": { "concurrent_branches": 1, "wall_clock_minutes": 120, "agent_pairs": 1 },
    "rationale": "no opinion gaps detected"
  },
  "test_list": {
    "total": 5,
    "by_status": { "pending": 3, "red": 0, "green": 1, "refactored": 1, "skipped": 0 },
    "completion_pct": 40
  },
  "experiments": [
    {
      "slug": "checkout",
      "branch_id": "br-feat-add-orders",
      "status": "running",
      "tests_passed": 2,
      "tests_failed": 0,
      "schema_diff_summary": null,
      "cycle_count": 4
    }
  ],
  "selection_log_recent": [
    { "timestamp": "2026-05-27T10:00:00Z", "title": "Experiment plan for F1-checkout" }
  ],
  "open_smells": []
}
```

## N=1 vs N≥2

The shape does not branch on `plan.mode`. An N=1 feature has `experiments.length === 1` (the feature branch); an N≥2 race has `experiments.length === N`. The same renderer surfaces both, with one row per experiment. Cross-experiment comparison rendering (`promote` vs `synthesize` decision aid) is intentionally out of scope here; that lives in the comparison-report renderer (FEIP-7208), which consumes the `experiments` array + per-experiment `outcomes.json` directly.

## Versioning

The shape carries no version field. Stability is enforced by the BDD assertion in `tests/bdd/tdd-feature-status.test.ts` (the "stable JSON schema shape" test). Any field addition that breaks that assertion is a contract change that needs deliberate review.
