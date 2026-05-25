# Branching + release methodology for Lakebase-paired projects

Status: Proposed. Pending the substrate primitives that automate it (see "Future work").
Owners: PSA team, lakebase-app-dev-kit maintainers.

## Context

Every Lakebase-paired project has two coupled axes of state: a git tree and a Lakebase project's branch tree. Schema changes flow through both. Without an opinionated answer for "where does new work live, where does it merge, and how does it get to production," each project invents its own variant and ends up with subtly different conventions for:

- which branch is authoritative for production
- whether feature branches merge to a shared integration branch or directly to production
- when (and how) a release is cut
- how rollback works
- whether a release candidate is built from the integration branch or from production

Inconsistency here makes coding agents (Claude Code, Genie, Foundry, etc.) less useful: they cannot recommend "the right place" to do work because there is no agreed answer. It also makes the substrate's `applyMigrations`, `createBranch`, `getSchemaDiff` primitives feel underspecified - they work, but the project still has to compose them by hand for every release.

This document records the convention and the release flow. Future substrate primitives encode it.

## Decision

### Branch convention

A project's branches form a **directed chain of long-running branches**, ending in `prod`. Each working-branch type targets a specific long-running branch in that chain - the architect decides which. Multiple working-branch types can target the same tier, or different tiers; both are valid.

Two-tier (default for most projects - all working types target `staging`):

```
prod                                     (only updated by a release)
 │
 ▼
staging                                  (next release accumulates here)
 │
 ▼
{feature, test, uat, perf}               (working branches off staging)
```

Three-tier example (architect splits early-stage work onto `dev`, later-stage validation onto `staging`):

```
prod              (only updated by a release from staging)
 │
 ▼
staging           (only updated by a release from dev; test/perf/uat work happens here)
 │       ▲
 │       └─── {test, uat, perf}          (validation branches off staging)
 ▼
dev               (next release accumulates here; feature work happens here)
 │
 ▼
{feature}                                (feature branches off dev)
```

Any chain length is supported (`dev → staging → preprod → prod`, etc.). The mapping from working-branch type to target tier is **per-project configuration**: in the three-tier example above, an architect chose `feature/*` → `dev` (early integration) while `test/*` / `uat/*` / `perf/*` → `staging` (validation against the pre-release surface). A different architect could choose all four types → `dev`, or all four → `staging`. The substrate stores this mapping as project metadata; agents and the extension read it instead of assuming.

Each adjacent pair `(from, to)` of long-running branches is promoted by the **same release flow** described below; the substrate's release primitive is parameterized over the from/to pair, not hardcoded to `staging → prod`.

Four points to commit to:

1. **`prod` is updated only by a release.** No PRs from working branches merge directly into `prod`. The only writer is the release flow described below.
2. **Every working-branch type has an explicit target tier**, set per project. The substrate's branch-creation primitive reads the per-type mapping; the extension's branch picker drives off the same metadata.
3. **A working branch always branches off its target tier.** Its Lakebase branch is a paired child of the target tier's Lakebase branch, and the corresponding PR's base is that target tier.
4. **Working branches are typed.** `feature/<n>`, `test/<n>`, `uat/<n>`, `perf/<n>`. The type drives both the target-tier mapping and the CI / approval policy.

### Working-branch types

| Type | Owner | Typical content | Default merge target |
|---|---|---|---|
| `feature/*` | Developer | New functionality or schema change | integration tier (lowest long-running) |
| `test/*` | QA | Regression scenarios, e2e harness updates | integration tier (lowest long-running) |
| `uat/*` | Product / UAT | Behavior verification against business scenarios | integration tier (lowest long-running) |
| `perf/*` | Perf engineer | Load + latency probes | integration tier (results only; no production code lands from `perf/*`) |

The "Default merge target" column is what the substrate ships when a project doesn't override it - in a two-tier chain that resolves to `staging`; in a three-tier chain it resolves to `dev`. The architect can remap any type to any long-running branch via the project's substrate metadata (e.g. `test/*` → `staging` while `feature/*` → `dev`, as in the three-tier example diagram).

Each type pairs to its own Lakebase branch via the substrate's `createBranch`. Schema changes live on the type's Lakebase branch until the PR merges to the type's configured target.

### Release-sprint flow

A release promotes one long-running branch (the **`from` tier**) into the next one above it (the **`to` tier**). In a two-tier chain there is one release: `from=staging, to=prod`. In a three-tier chain there are two adjacent releases: `from=dev, to=staging` and `from=staging, to=prod`. The shape of each release is identical; only the from/to labels change.

A release proceeds in four ordered phases. Each is intended to be a substrate primitive; the orchestrator composes them with explicit gates. The descriptions below use `from` / `to` placeholders so the same flow applies at every tier boundary.

#### Phase 1: Cut RC from `to`

Branch the release candidate from *current* `to` (git + Lakebase), NOT from `from`.

```
git fetch && git switch <to>
git switch -c rc/<release-id>
# substrate creates Lakebase branch paired to rc/<release-id> off <to>'s Lakebase
```

Then merge `from` into the RC. This is where the "things settling on `from`" get included or held back:

```
git merge --no-ff <from>
# resolve conflicts; remove any commit that should not ship
```

**Why off `to` and not off `from`?** Cutting from `to` locks the release surface. The RC starts from a known-shipped state (whatever is currently live one tier up) and adds *only* the changes the release manager actively merges in. Cutting from `from` would inherit whatever happens to be on `from`, including in-progress work that did not get explicit release sign-off.

#### Phase 2: Regression test the RC

Run the project's full e2e suite against the RC's Lakebase branch.

```
# substrate primitive
lakebase-migrate apply --instance <id> --branch rc/<release-id>
# project's test command
./mvnw test              # or uv run pytest, or npx vitest, ...
```

This is the rehearsal. The RC's Lakebase branch is created from `to`'s Lakebase, so it carries `to`'s current data and the test exercises the migration + behavior against that real shape. The substrate's `applyMigrations` is where Lakebase-specific compatibility (e.g. Flyway's `baselineOnMigrate` flag) lives, in one place.

#### Phase 3: Cut backup of `to`

Before touching `to`, snapshot it.

```
# substrate primitive
lakebase-cut-backup --instance <id> --branch <to> --tag <to>-backup-<release-id>
git tag <to>-backup-<release-id> <to>
git push origin <to>-backup-<release-id>
```

**Why a separate backup?** Rollback should be a one-step revert, not a recovery exercise. Cutting the backup *before* the migrate step means the worst-case rollback is `git switch <to> && git reset --hard <to>-backup-<release-id>` + repoint app config (or downstream tier metadata) at the snapshot Lakebase branch. Without this step, rolling back means hand-reconstructing `to` from the RC + prior tags. The backup is cut on every release, at every tier - `staging-backup-<id>` matters less than `prod-backup-<id>` but the same primitive runs for both.

#### Phase 4: Migrate `to`

Promote the RC into `to`.

```
# substrate primitive
lakebase-migrate apply --instance <id> --branch <to>
git switch <to>
git merge --ff-only rc/<release-id>
git push origin <to>
# app deploy (only when <to> == prod) or downstream propagation otherwise
```

The substrate's `applyMigrations` applies the same migrations that already ran on the RC in Phase 2, against the real `to` Lakebase. Same primitive, same compatibility flags, same code path - the difference is only the target branch. The app-deploy step is `to == prod` specific; intermediate-tier releases (e.g. `dev → staging`) skip the deploy and continue accumulating until the next `to` is promoted.

### Rollback

If a release misbehaves after Phase 4 completes (at any tier):

```
git switch <to> && git reset --hard <to>-backup-<release-id>
git push --force-with-lease origin <to>
# app (only when <to> == prod): redeploy from <to>-backup-<release-id>
# Lakebase: repoint downstream config (app for prod, or next-tier release planner) at the backup branch
```

Rollback is invasive (it rewrites `to`'s git history). The convention accepts this cost so that the *common* case (successful release) is simple. If rollback frequency becomes high, the convention should be revisited. The cost grows with the chain length - rolling back `dev → staging` is cheap because nothing downstream has shipped; rolling back `staging → prod` is the expensive case.

## Consequences

**Positive:**
- Coding agents have a single answer for "where does this work happen": "branch off your type's target tier (read from project metadata), named with the right type prefix."
- Release sequencing is mechanical and reviewable at every tier: a check that all four phases ran in order is enough to audit a release.
- Rollback is a known one-step procedure.
- The substrate primitives that encode this convention are small in number and orthogonal - each phase is a single substrate call. The same primitives are reused for every adjacent-tier promotion; N-tier doesn't multiply the primitive surface.

**Negative:**
- Multiple long-lived integration branches (minimum `prod` + one integration tier). Adds merge-management overhead. Three- and four-tier chains compound this.
- The integration tier can drift if not actively curated - merges to it that the next release doesn't want must be explicitly excluded during Phase 1's `git merge --no-ff <from>` step.
- Rollback is invasive (force-push to the `to` tier). Teams uncomfortable with rewriting history at any tier will need a different rollback model (e.g. revert-forward via a new release).
- N-tier shops have more release events to operate. The release primitive amortizes this (same substrate call per tier) but operators still gate each promotion.

## Anti-patterns this rules out

- **Cutting the RC from `from`.** Loses the "locked surface" property. Anything on `from` at branch-time ships, including half-finished work. Applies at every tier - cutting the staging→prod RC from staging is the canonical mistake, but cutting a dev→staging RC from dev is the same mistake.
- **Merging working branches directly to a tier above their configured target.** Skips the intervening release(s); upstream tiers become de facto integration branches.
- **Running migrations against any long-running branch without a backup tag.** Rollback becomes a recovery exercise. The backup primitive runs on every release, not just staging→prod.
- **Untyped working branches.** Loses the ability to gate CI workflows by type, and loses the ability for an agent to recommend "this should be a `perf/*` branch, not a `feature/*` branch."
- **Multiple concurrent releases sharing a single `to` tier.** Phase 1 assumes one in-flight release at a time per tier. Concurrent releases require either a release-tagged variant of this convention or sequencing - and the constraint is per-tier, so a project mid-promotion of `dev → staging` can still accept new feature merges to `dev`.
- **Hardcoding `staging` or `prod` in test scenarios.** Tests should be parameterized over their target tier (read from project metadata or scenario context), so the same e2e suite exercises two-tier and N-tier configurations identically. Scenarios that contain `branch: 'main'` or `git checkout staging` literals will silently misbehave when the chain shape changes.

## Future work

Substrate primitives that encode this convention (FEIP-7059 roadmap). Note that none of the release primitives mention specific tier names - they all take `from` / `to` (or just `to` for backup/migrate) so the same primitive serves every adjacent pair:

- `bootstrap-branch-convention({chain, workingTypeTargets})` - given a fresh project, creates the configured long-running chain (default `[staging, prod]`; an N-tier shop passes e.g. `[dev, staging, prod]`) plus the working-branch types, all from prod (git + Lakebase), and writes parent-pair metadata + the type→target-tier mapping. One-time per project.
- `cutRC({from, to, releaseId})` - branches the RC off current `to` (git + Lakebase) and merges `from` in.
- `regressionTest({rc, suite})` - runs the project's full e2e suite against the RC's Lakebase branch.
- `cutBackup({to, releaseId})` - snapshots current `to`'s Lakebase branch + writes a git tag.
- `migrate({rc, to, releaseId})` - applies migrations against `to`'s Lakebase branch + fast-forwards git `to`.
- `release({from, to, releaseId})` - orchestrator. Calls the four phases in order with explicit human-or-policy gates between each. Same primitive for every adjacent-tier promotion; the caller passes the pair.

Companion changes:

- Extension branch picker (VS Code) restricts new-branch creation to the convention's types and reads the type→target-tier mapping from project metadata.
- Scaffolded project YAMLs (`pr.yml`, `merge.yml`) call substrate primitives instead of inlining `mvn flyway:migrate` / `alembic upgrade head` (FEIP-7096). `merge.yml`'s `on: push: branches: [...]` list is generated from the project's long-running-branch chain rather than hardcoded.
- Coding-agent skills reference this document as the source for "how do releases work in a Lakebase-paired project."
- Integration test scenarios in the extension (and any downstream consumer) parameterize their merge target via scenario context (e.g. `ctx.baseBranch`) so the same scenario file works at any tier.

## Open questions

- **Hotfix path.** This document does not yet describe a "skip integration tiers, urgent fix to prod" path. The convention currently implies all hotfixes go through the full four-phase release at every tier. If that proves too slow, an explicit hotfix variant is needed - probably a `hotfix/*` working-branch type that targets a release-candidate cut directly from prod, skipping the intermediate tiers.
- **Lakebase branch pruning policy.** When `feature/foo` merges to its target tier, what happens to its Lakebase branch? This document is silent; needs a paired retention policy in the `lakebase-scm-workflows` skill.
- **Per-tier policy gates.** The release flow is uniform across tiers, but the *gates* between phases probably aren't - e.g. an intermediate `dev → staging` release might require only the regression suite to pass, while `staging → prod` additionally requires QA sign-off + an on-call window. This document does not yet describe a per-tier policy schema; the `release` orchestrator's gate handling will need it.
