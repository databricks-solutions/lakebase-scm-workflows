# lakebase-tdd-workflows

Substrate for test-driven development on paired Lakebase branches. Canonical Beck-style RED → GREEN → REFACTOR composed with paired-branch primitives (cheap experiments, parent-aware schema diff, real per-branch databases) and HITL gates at every phase boundary.

This README is the human-facing overview. The agent's operating contract — hard rules, function names, code patterns — lives in [`SKILL.md`](SKILL.md).

## When to use

- A new feature needs a spec authored, architected, and test-listed.
- A feature needs cutting, running, and tearing down on a paired branch.
- A TDD cycle (RED → GREEN → REFACTOR) needs running against a per-branch Lakebase DB.
- Multiple parallel experiments need comparing and a winner promoted or synthesized.
- Bad smells (test list drift, cycle stall, fragility) need detecting and surfacing to a Product Owner.

## Lexicon

| Term | Definition |
|---|---|
| **Feature** | A user-facing capability. Has stories with ACs. Lives on one feature branch. The default and most common mode of work. |
| **AC** | Acceptance Criterion. One observable behavior. Tagged `[API]` / `[E2E]` / `[Infra]`. |
| **Test list** | Beck's planning artifact. Ordered list of behavioral scenarios that define done. Lives at feature level. |
| **Cycle** | One RED → GREEN → REFACTOR pass for a single test list item. |
| **Spike** | Throwaway exploration on a Lakebase branch. No test list, no rigor. Goal: learn. Code is never promoted as-is. |
| **Experiment** | A rigorous TDD branch — has a test list, runs cycles, ends with working code + tests. When N=1, the experiment IS the feature. The substrate uses "experiment" as the internal noun so the same primitives generalize to N≥2. |
| **N=1 (the default — just a feature)** | One branch, iterative refinement. The branch IS the feature. No promote/synthesize ceremony, no compare report. This is what most work looks like. |
| **N≥2 (parallel experiments)** | Deliberate race between competing strategies. Used when the design-spec gate finds opinion gaps the team genuinely wants to resolve by trying them. HITL chooses promote vs synthesize at the end. |
| **Promote** | (N≥2 only) Take one experiment as-is into the feature PR. The losers are archived. |
| **Synthesize** | (N≥2 only) PO menu-picks capabilities across experiments; spec is renegotiated; a fresh TDD cycle on a new branch produces the final code. |
| **Bad smell** | A pattern the orchestrator detects that signals the workflow is sliding. Surfaces a proposed remediation to the HITL. |
| **Adapter** | Pluggable component that syncs the spec format to/from an external tracker (JIRA, Linear, GitHub Issues, plain markdown). |

The substrate API keeps "experiment" as the noun so the same primitives serve both N=1 and N≥2. When you're racing strategies you have experiments. Otherwise you have a feature.

## Roles

| Role | Responsibility | Agent prompt |
|---|---|---|
| **Spec Author** | Composes the initial draft spec — features, stories, ACs. | (Project skill, e.g. `/design`.) |
| **Architect Reviewer** | Applies layering lens; populates `layer` and `architectural_notes` per AC; imports `software-design-principles`. | [`agents/architect-reviewer.md`](agents/architect-reviewer.md) |
| **Test Strategist** | Converts annotated ACs into a Beck-style ordered test list; emits per-AC views. | [`agents/test-strategist.md`](agents/test-strategist.md) |
| **Orchestrator (Scrum-Master)** | Runs design-spec gate; spawns experiments to budget; runs cycles; watches smells; presents outcomes to HITL. | [`agents/scrum-master.md`](agents/scrum-master.md) |
| **Navigator** | PLAN, RED (writes failing tests), REVIEW. Never weakens an assertion. | [`agents/navigator.md`](agents/navigator.md) |
| **Driver** | GREEN (minimal honest code), REFACTOR. Never deletes or weakens a test. | [`agents/driver.md`](agents/driver.md) |
| **Product Owner / HITL** | Owns spec, ACs, test list ordering. Decides promote vs synthesize. Owns every gate. | The human. |

## Phases and gates

| Phase | Output | HITL gate |
|---|---|---|
| 0 Discovery | Draft `feature.{md,json}` + `story.{md,json}` + `ac.{md,json}` per AC | **Gate 1 — Draft spec** |
| 1 Architectural review | Layer + architectural_notes populated; `architecture.md` summary | **Gate 2 — Architectural lens** |
| 2 Test-list construction | Ordered `test-list.{md,json}` at feature level | **Gate 3 — Test list ordering** |
| 3 Design-spec gate | Experiment plan in `selection-log.md` (N, strategies, budget) | **Gate 4 — Experiment plan** |
| 4 Implementation | Per-experiment cycles producing tests + code | Continuous: smells; final: promote / synthesize choice |

Each phase has a defined predecessor + artifact contract. The orchestrator refuses to transition if prior artifacts are missing or invalid.

## Operations

What the substrate does on your behalf, in user-journey order. You don't invoke these directly — the agent does, in response to the prompts in [How to use](#how-to-use).

### 1. Design-spec gate

Once the test list is approved (Gate 3), the agent runs the design-spec gate analyzer — phase 3. It scans the list for opinion-gap signals (keywords like "either", "consider", "alternatively", "decide", "TBD") and proposes either N=1 (iterative refinement) or N≥2 (parallel race), with strategies and a resource budget (concurrent branches, wall-clock minutes, agent-pair count).

The proposal is conservative by design: the analyzer's job is to surface the choice to the PO, not to decide. The PO signs off at Gate 4. The plan and the decision are persisted here:

```
.tdd/
  features/
    F1-checkout/
      plan.json                  ← { feature_id, N, mode, strategies[], budget, rationale }
  selection-log.md               ← append-only HITL decision record (every gate)
```

### 2. Experiment

With the plan approved, the agent cuts branches per the plan — one for N=1, multiple for N≥2 — and runs cycles against them in phase 4 (Implementation). Each experiment gets its own subdirectory:

```
.tdd/
  experiments/
    F1-checkout/
      checkout/                  ← single experiment (N=1) — slug matches the feature
        branch.txt               ← Lakebase branch id
        notes.md                 ← strategy + learning notes
        outcomes.json            ← { status, tests_passed, tests_failed, schema_diff_summary, ... }
        timeline.json            ← per-cycle + smell history
      exp-postgres-arrays/       ← parallel experiment (N≥2)
        ...
      exp-json-blob/
        ...
      _archive/                  ← losers from a promote decision land here
        exp-json-blob/
```

Teardown is HITL-gated: the experiment record is preserved on disk by default even when the Lakebase branch is removed, so the learning survives. The orchestrator proposes deletions to the Product Owner; it never tears down unilaterally.

### 3. Spike

Side-mode for exploration that sits outside the main flow. No test list, no gates, no rigor. The agent runs this when you ask to "spike X" or "explore whether Y is possible" — typically before authoring a spec, to de-risk a choice you'll later put into the design-spec gate.

```
.tdd/
  spikes/
    explore-cart-storage/
      branch.txt                 ← Lakebase branch id (often deleted shortly after)
      notes.md                   ← learning that carries forward; survives branch teardown
```

The branch is deleted by default after notes are captured. **Spike code is never promoted into a TDD branch** — only the learning carries over.

Before cutting any new experiment, the orchestrator checks the budget — at the concurrent-branch or wall-clock limit, it asks the PO to extend or stop, rather than cutting anyway.

## How to use

Three flows — shown as what you'd prompt your agent to do, using a cart-checkout example throughout. The agent reads [`SKILL.md`](SKILL.md) (plus the Scrum-Master / Navigator / Driver agent prompts) and runs the underlying substrate primitives on your behalf.

The project-level slash commands `/design` and `/build` are the canonical entry points. They're thin wrappers that project skills install on top of this substrate — they handle project-specific concerns (JIRA hierarchy, IDE branch suggestions, manual review gates) and delegate the workflow facilitation here. If a slash command isn't installed in your project, just describe what you want to your agent directly; the prompts below work either way.

### 1. Author a feature spec

Just describe what you want to build. The design agent walks Spec Author → Architect Reviewer → Test Strategist and asks you to sign off at each HITL gate; you don't need to tell it about schemas, file layout, IDs, or which questions to ask — that's its job.

> `/design`

…or describe it freeform:

> "I want to build a checkout flow. A shopper should be able to submit their cart and get back an order id with a 201. Empty carts should be rejected with a 400. There'll be more behaviors later (inventory checks, payment) but start with just place-order. Walk me through drafting the spec."

When you're done, your `.tdd/features/F1-checkout/` tree has the feature, stories, ACs, architecture notes, and an ordered test list. If you'd rather author by hand, copy `templates/tdd-bootstrap/.tdd/` into your project and edit the files using [`references/spec-format.md`](references/spec-format.md) as the layout reference.

### 2. Build a feature end-to-end (the N=1 default)

The most common flow. One feature, one branch, iterative refinement. The branch IS the feature.

> `/build F1-checkout`

…or:

> "Build the checkout feature."

Scrum-Master picks up the approved spec, runs the design-spec gate (which proposes N=1 for work without opinion gaps), waits for your sign-off, cuts the feature branch off staging, and alternates Navigator + Driver per test list item. After every cycle it runs the smell detectors and pauses to surface any remediation to you. When the list is exhausted, the feature branch goes straight to PR — no promote/synthesize step.

### 3. Race parallel experiments and either promote or synthesize (N≥2)

When the team has a real opinion gap and wants to resolve it by trying competing strategies. You name the strategies; the agent runs them in parallel.

> "Build the checkout feature, but I want to compare two ways of storing the cart — one as a Postgres array column on orders, one as a JSON blob on a separate carts table. Race them and let me pick a winner."

Scrum-Master cuts a branch per strategy, runs the same test list through each, and at convergence presents the comparison report. It asks you to choose:

- **Promote** — one experiment is the clear winner; take it as-is into the feature PR.
- **Synthesize** — pick capabilities across the experiments (storage schema from one, API surface from the other), renegotiate the spec, and run a fresh cycle on a synthesized branch.
- **Continue** — let cycles finish.
- **Abandon all** — stalled population; re-run the design-spec gate.

The `hitlApproved` flag on the promote and synthesize primitives is enforced at the function boundary, so the agent cannot skip this gate.

### CLI cheat sheet

For when you want to run something directly without the agent. Most TDD work goes through `/design` and `/build`; these are useful for debugging or one-off introspection.

| Command | Purpose |
|---|---|
| `lakebase-feature-status <featureId> [--tdd <dir>] [--json]` | One-screen snapshot of a feature's TDD workflow state (phase, plan, test-list completion, experiments, recent decisions, open smells). |
| `node dist/scripts/tdd/spec-sync.cli.js <tddDir>` | Walk the `.tdd/` tree and print drift reports. Exit 0 even when reports exist (warn-only by design). |
| `node dist/scripts/tdd/test-list.cli.js <tddDir> <featureId>` | Regenerate per-AC views from the feature-level master test list. |
| `bash tests/run_all.sh` (per scaffolded project) | Run every `validate_*.sh` in the project's `tests/` directory (the project's full validation suite). |

## Project-level entry points

- **`/design`** — wraps Spec Author + Architect Reviewer + Test Strategist phases. Project-specific JIRA hierarchy creation lives here.
- **`/build`** — wraps Orchestrator. Project-specific PR/merge ceremony lives here.
- **`/ship`** — lives in `lakebase-release-workflows`. Not part of this skill.

Substrate ships no slash commands. It ships skills + agents + scripts + CLI bins. The MCP server (`apps/mcp-server/`) exposes the tool surface for MCP-capable consumers.

## Integration with sibling skills

- **[`lakebase-scm-workflows`](../lakebase-scm-workflows/README.md)** — `createFeatureBranch`, `deleteBranch`, `getSchemaDiff`, `getConnection`. Experiments and spikes are paired branches.
- **`lakebase-release-workflows`** — Tier model (feature → staging → production), TTL, "never delete production." TDD defers to release-workflows for everything past PR merge.
- **[`software-design-principles`](../software-design-principles/SKILL.md)** — Imported as canon by Architect Reviewer (layering + cross-cutting concerns) and Navigator (refactor heuristics).
