---
name: lakebase-tdd-workflows
description: "Test-driven development against paired Lakebase branches. Canonical Beck-style RED-GREEN-REFACTOR composed with paired-branch primitives (cheap experiments, parent-aware schema diff, real per-branch databases). Use when planning a new feature, running design-spec gates, running TDD cycles, comparing parallel experiments, or detecting workflow bad smells. Imports software-design-principles canon. Builds on lakebase-scm-workflows + lakebase-release-workflows."
user-invocable: true
---

# lakebase-tdd-workflows — agent contract

Agent-facing contract: hard rules, phase flow, agent prompt index, and concrete code patterns for the substrate primitives.

For the human-facing overview (lexicon, roles narrative, how-to-use prompts, project entry points) see [`README.md`](README.md).

## Hard rules

The contract every agent (Navigator, Driver, Orchestrator) and every human collaborator must honor.

1. Tests are immutable until the test list itself is renegotiated through the PO. Never delete or weaken a test to make it pass.
2. "Minimal code" means minimal *honest* code that satisfies the current test list, not just the current test. Use the test list as your horizon.
3. After every GREEN, ask: "would a fresh reader infer the right concept from this API now?" If no, request REFACTOR before the next test.
4. Test at the outermost public boundary that maps to the AC. Inner-loop unit tests are reserved for pure logic that can't be exercised through the outer boundary.
5. A correct refactor should not change the outer-boundary tests. A refactor that requires editing tests is suspect.
6. Never make a private method public to test it.
7. Test count is a lagging indicator. The leading indicator is "how cheap is the next test?" Rising cost = design problem.
8. Spike code is throwaway. Promote nothing from a spike branch into a TDD branch except notes.
9. N=1 mode is iterative refinement. There is no promote/synthesize ceremony — the branch IS the feature.

See [`agents/navigator.md`](agents/navigator.md) and [`agents/driver.md`](agents/driver.md) for per-role specializations.

## Phases and gates

| Phase | Output | HITL gate |
|---|---|---|
| 0 Discovery | Draft `feature.{md,json}` + `story.{md,json}` + `ac.{md,json}` per AC | **Gate 1 — Draft spec** |
| 1 Architectural review | `layer` + `architectural_notes` populated; `architecture.md` summary | **Gate 2 — Architectural lens** |
| 2 Test-list construction | Ordered `test-list.{md,json}` at feature level | **Gate 3 — Test list ordering** |
| 3 Design-spec gate | Experiment plan in `selection-log.md` + `features/<F>/plan.json` | **Gate 4 — Experiment plan** |
| 4 Implementation | Per-experiment cycles producing tests + code | Continuous: smells; final: promote / synthesize choice |

Refuse to transition if prior-phase artifacts are missing or invalid.

## Agent prompts

Load the per-role prompt for the phase you're in:

- [`agents/architect-reviewer.md`](agents/architect-reviewer.md) — phase 1, populates `layer` and `architectural_notes`, imports `software-design-principles`.
- [`agents/test-strategist.md`](agents/test-strategist.md) — phase 2, builds the Beck-style ordered test list.
- [`agents/scrum-master.md`](agents/scrum-master.md) — phases 3 → 4, orchestrates the design-spec gate, spawns experiments, runs cycles, watches smells, surfaces to HITL.
- [`agents/navigator.md`](agents/navigator.md) — phase 4 PLAN + RED + REVIEW.
- [`agents/driver.md`](agents/driver.md) — phase 4 GREEN + REFACTOR.

## References

- [`references/spec-format.md`](references/spec-format.md) — full `.tdd/` directory layout + markdown ↔ JSON contract.
- `scripts/tdd/schemas/` — JSON Schemas validated by `spec-sync.ts`.
- [`../software-design-principles/SKILL.md`](../software-design-principles/SKILL.md) — engineering canon (SOLID, DRY, DTSTTCPW, layered architecture, cross-cutting concerns, NFRs). Required reading for Architect Reviewer and Navigator.

## Operations

Concrete invocations of the substrate primitives.

### Design-spec gate (phase 3)

```ts
import { analyzeForGate, recordPlan, writePlan } from "@databricks-solutions/lakebase-app-dev-kit/tdd/design-spec-gate";
import { canCutAnotherExperiment } from "@databricks-solutions/lakebase-app-dev-kit/tdd/budget";

const analysis = analyzeForGate(".tdd", "F1");
// analysis.opinion_gaps[]  — items the analyzer flagged as opinion gaps
// analysis.proposed_plan   — { mode: "N=1" | "N>=2", N, strategies[], budget, rationale }

// Surface to PO. On Gate 4 approval, persist:
recordPlan(".tdd", analysis.proposed_plan, "kevin@example.com");
writePlan(".tdd", analysis.proposed_plan);

// Before cutting any experiment, check the budget:
const ok = canCutAnotherExperiment(".tdd", "F1");
if (!ok.ok) throw new Error(`budget: ${ok.reason}`);
```

### Experiment (phase 4)

```ts
import { cutExperiment, listExperiments, readOutcomes, writeOutcomes, deleteExperiment }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/experiment";

// N=1 — slug matches the feature.
const feature = await cutExperiment({
  instance: "proj-checkout",
  tddDir: ".tdd",
  featureId: "F1",
  experimentSlug: "checkout",       // N=1: slug = feature name
  branch: "checkout",
  parentBranch: "staging",
});
// feature.dir === ".tdd/experiments/F1/checkout"
// Writes branch.txt, notes.md, outcomes.json (status: "running"), timeline.json.

writeOutcomes(".tdd", "F1", "checkout", { status: "succeeded", tests_passed: 2 });

// Teardown is HITL-gated. deleteBranchToo defaults to false — record survives.
await deleteExperiment({
  instance: "proj-checkout",
  tddDir: ".tdd",
  featureId: "F1",
  experimentSlug: "checkout",
  deleteBranchToo: false,
});
```

### Spike (side-mode)

```ts
import { cutSpike, listSpikes, deleteSpike }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/spike";

await cutSpike({
  instance: "proj-checkout",
  tddDir: ".tdd",
  spikeSlug: "explore-cart-storage",
  branch: "spike-explore-cart-storage",
  parentBranch: "staging",
});

// Notes captured, branch deleted by default (throwaway).
await deleteSpike({
  instance: "proj-checkout",
  tddDir: ".tdd",
  spikeSlug: "explore-cart-storage",
});
// Notes preserved at .tdd/spikes/explore-cart-storage/notes.md.
```

### Cycle (RED → GREEN → REFACTOR)

```ts
import { beginCycle, markGreen, markRefactored, flagSmells, listCycles, openBranchDsn }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/run-cycle";

const scope = {
  tddDir: ".tdd",
  feature_id: "F1",
  story_id: "S1",
  ac_id: "AC1",
  experiment_slug: "checkout",
  branch_id: "checkout",
};

// Open a DSN against the experiment's branch DB (no mocks).
const dsn = await openBranchDsn({ instance: "proj-checkout", branch_id: "checkout" });

// RED — Navigator writes a failing test, persists the cycle artifact.
const c1 = beginCycle({
  ...scope,
  test_id: "T1",
  test_description: "POST /orders returns 201 on valid cart",
  navigator_plan: "force the public boundary to accept a Cart payload",
});

// GREEN — Driver returns and Navigator reviews.
markGreen(scope, c1.cycle_id, "added POST handler + repository write");

// Optional REFACTOR — Navigator requests, Driver applies, no outer-boundary test changes.
markRefactored(scope, c1.cycle_id, "extracted CartRepository");

// Navigator-flagged smells (Hard Rule 1, 4 violations).
flagSmells(scope, c1.cycle_id, ["test-deletion-attempt"]);
```

### Smells (after every cycle)

```ts
import { runDetectorsForScope, writeSmellsLog, readSmellsLog, SMELL_CATALOG }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/smells";

const hits = runDetectorsForScope(".tdd", scope);
if (hits.length) {
  writeSmellsLog(".tdd", hits);
  // Surface each hit + the SMELL_CATALOG remediation to the PO.
  // Never auto-apply remediations.
}
```

### Compare (N≥2 convergence)

```ts
import { compareExperiments }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/compare-experiments";

const report = compareExperiments(".tdd", "F1");
// report.rows[].signal       — "winning" | "stalled" | "abandoned" | "running" | "unknown"
// report.recommendation      — "promote" | "synthesize" | "continue" | "abandon-all"
// report.rationale           — short explanation surfaced to the PO
```

### Promote (N≥2, single winner)

```ts
import { promoteExperiment }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/promote-experiment";

// Refuses to run without hitlApproved: true (PO gate enforced at the function boundary).
const result = promoteExperiment({
  tddDir: ".tdd",
  featureId: "F1",
  winnerSlug: "exp-postgres-arrays",
  hitlApproved: true,
  approverEmail: "kevin@example.com",
});
// Winner outcome: status "succeeded". Losers: outcome "abandoned", dirs moved to _archive/.
// feature.json transitions to "ready-for-review". Appends to selection-log.md.
```

### Synthesize (N≥2, menu-pick)

```ts
import { synthesizeExperiments }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/synthesis";

// Refuses to run without hitlApproved: true.
const result = await synthesizeExperiments({
  instance: "proj-checkout",
  tddDir: ".tdd",
  featureId: "F1",
  picks: [
    { source_slug: "exp-postgres-arrays", capability: "storage schema" },
    { source_slug: "exp-json-blob",       capability: "API surface" },
  ],
  synthesizedSlug: "exp-synth",
  branch: "checkout-synth",
  parentBranch: "staging",
  hitlApproved: true,
  approverEmail: "kevin@example.com",
});
// Writes synthesis/<F>/synthesis-<date>.md decision record + synthesized-spec/ subtree.
// Cuts the synthesized branch. Appends to selection-log.md.
```

### Spec sync (drift detection)

```ts
import { validateSpec, readFeature, writeFeature, readWorkflowState, writeWorkflowState }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/spec-sync";

const drift = validateSpec(".tdd");
// drift[].kind — "schema" | "pair-missing" | "narrative-empty" | "id-mismatch"
// Warn-only; do not auto-correct narrative drift.
```

### Test list transformation

```ts
import { readMasterTestList, writeMasterTestList, viewByAc, viewsForAllAcs, writePerAcViews }
  from "@databricks-solutions/lakebase-app-dev-kit/tdd/test-list";

const list = readMasterTestList(".tdd", "F1");
writePerAcViews(".tdd", "F1", list);
// Emits .tdd/features/<F>/stories/<S>/test-list-per-ac.json under each story dir.
```

## Flow patterns

End-to-end orchestrator patterns the Scrum-Master agent runs in response to `/design` and `/build`. Each flow is what the agent assembles from the primitives above; the human-facing prompts that trigger each flow live in [`README.md`](README.md).

### Author + validate spec (response to `/design`)

```ts
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { validateSpec } from "@databricks-solutions/lakebase-app-dev-kit/tdd/spec-sync";

const tdd = ".tdd";
const fdir = join(tdd, "features", "F1-checkout");
const sdir = join(fdir, "stories", "S1-place-order");
mkdirSync(join(sdir, "acs"), { recursive: true });

writeFileSync(join(fdir, "feature.json"), JSON.stringify({
  id: "F1", name: "Checkout flow", status: "draft", tdd_mode: "N=1", stories: ["S1"],
}));
writeFileSync(join(fdir, "feature.md"), "# Checkout flow\n\nDesign intent.\n");

writeFileSync(join(sdir, "story.json"), JSON.stringify({
  id: "S1", asA: "shopper", iWantTo: "place an order",
  soThat: "I receive the goods", feature_id: "F1",
}));
writeFileSync(join(sdir, "story.md"), "# Place order\n\nNarrative.\n");

writeFileSync(join(sdir, "acs", "AC1.json"), JSON.stringify({
  id: "AC1", layer: "API", given: "valid cart", when: "POST /orders",
  then: "201 with order id", status: "draft", story_id: "S1",
}));
writeFileSync(join(sdir, "acs", "AC1.md"), "# AC1\n\nAC narrative.\n");

const drift = validateSpec(tdd);
if (drift.length) console.warn(drift);
```

### N=1 cycle end-to-end (response to `/build`, simple case)

```ts
import { writeMasterTestList } from "@databricks-solutions/lakebase-app-dev-kit/tdd/test-list";
import { analyzeForGate, writePlan, recordPlan } from "@databricks-solutions/lakebase-app-dev-kit/tdd/design-spec-gate";
import { cutExperiment, writeOutcomes } from "@databricks-solutions/lakebase-app-dev-kit/tdd/experiment";
import { beginCycle, markGreen } from "@databricks-solutions/lakebase-app-dev-kit/tdd/run-cycle";
import { runDetectorsForScope, writeSmellsLog } from "@databricks-solutions/lakebase-app-dev-kit/tdd/smells";

const tdd = ".tdd"; const featureId = "F1";

writeMasterTestList(tdd, { feature_id: featureId, ordered_for: "design-momentum", items: [
  { id: "T1", description: "POST /orders returns 201 on valid cart", ac_id: "AC1", status: "pending" },
  { id: "T2", description: "POST /orders rejects empty cart with 400", ac_id: "AC1", status: "pending" },
]});

const analysis = analyzeForGate(tdd, featureId);   // -> { mode: "N=1", N: 1, ... }
recordPlan(tdd, analysis.proposed_plan, "kevin@example.com");
writePlan(tdd, analysis.proposed_plan);

const feature = await cutExperiment({
  instance: "proj-checkout", tddDir: tdd,
  featureId, experimentSlug: "checkout", branch: "checkout", parentBranch: "staging",
});

const scope = { tddDir: tdd, feature_id: featureId, story_id: "S1", ac_id: "AC1",
                experiment_slug: feature.experiment_slug, branch_id: feature.branch_id };

const c1 = beginCycle({ ...scope, test_id: "T1",
  test_description: "POST /orders returns 201 on valid cart",
  navigator_plan: "force the public boundary to accept a Cart payload" });
markGreen(scope, c1.cycle_id, "added POST handler + repository write");

const hits = runDetectorsForScope(tdd, scope);
if (hits.length) writeSmellsLog(tdd, hits);

writeOutcomes(tdd, featureId, feature.experiment_slug, { status: "succeeded", tests_passed: 2 });
```

### N≥2 race + promote/synthesize

```ts
import { cutExperiment, writeOutcomes } from "@databricks-solutions/lakebase-app-dev-kit/tdd/experiment";
import { compareExperiments } from "@databricks-solutions/lakebase-app-dev-kit/tdd/compare-experiments";
import { promoteExperiment } from "@databricks-solutions/lakebase-app-dev-kit/tdd/promote-experiment";
import { synthesizeExperiments } from "@databricks-solutions/lakebase-app-dev-kit/tdd/synthesis";

const tdd = ".tdd"; const featureId = "F1";

await cutExperiment({ instance: "proj-checkout", tddDir: tdd, featureId,
  experimentSlug: "exp-postgres-arrays", branch: "checkout-pg-arrays", parentBranch: "staging" });
await cutExperiment({ instance: "proj-checkout", tddDir: tdd, featureId,
  experimentSlug: "exp-json-blob", branch: "checkout-json-blob", parentBranch: "staging" });

// ... cycles run on each branch via beginCycle/markGreen ...

writeOutcomes(tdd, featureId, "exp-postgres-arrays", { status: "succeeded", tests_passed: 5 });
writeOutcomes(tdd, featureId, "exp-json-blob",       { status: "succeeded", tests_passed: 5 });

const report = compareExperiments(tdd, featureId);

if (report.recommendation === "promote") {
  const winner = report.rows.find((r) => r.signal === "winning")!;
  promoteExperiment({ tddDir: tdd, featureId, winnerSlug: winner.experiment_slug,
                      hitlApproved: true, approverEmail: "kevin@example.com" });
} else if (report.recommendation === "synthesize") {
  await synthesizeExperiments({
    instance: "proj-checkout", tddDir: tdd, featureId,
    picks: [
      { source_slug: "exp-postgres-arrays", capability: "storage schema" },
      { source_slug: "exp-json-blob",       capability: "API surface" },
    ],
    synthesizedSlug: "exp-synth", branch: "checkout-synth",
    hitlApproved: true, approverEmail: "kevin@example.com",
  });
}
```

## Adapters

Bundled: `markdown.ts` (no-op default — the spec IS the tracking), `jira.ts` (stub). Project skills wire in the adapter they want via `.tdd/adapters/<name>.json` config.

The `SpecAdapter` interface extends `SyncEventHooks` — implementations may opt into `onPhaseTransition`, `onCycleComplete`, `onSmellDetected` hooks for status-mirroring to external trackers. Adapter failures must degrade gracefully — the on-disk spec is the source of truth.

## CLI bins

For non-agent invocation (debugging, CI introspection):

| Command | Purpose |
|---|---|
| `node scripts/tdd/spec-sync.js <tddDir>` | Walk the `.tdd/` tree and print drift reports. Exits 0 even when reports exist — warn-only. |
| `node scripts/tdd/test-list.js <tddDir> <featureId>` | Regenerate per-AC views from the feature-level master test list. |
