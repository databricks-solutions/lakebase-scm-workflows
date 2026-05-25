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

```
prod                                     (only updated by a release)
 │
 ▼
staging                                  (next release accumulates here)
 │
 ▼
{feature, test, uat, perf}               (working branches off staging)
```

Four points to commit to:

1. **`prod` is updated only by a release.** No PRs from working branches merge directly into `prod`. The only writer is the release flow described below.
2. **`staging` is the integration branch.** Working branches merge here. Continuous - there is always exactly one `staging` branch and it always points at "the next release."
3. **Working branches branch off `staging`, not `prod`.** Their Lakebase branches are paired children of staging's Lakebase branch.
4. **Working branches are typed.** `feature/<n>`, `test/<n>`, `uat/<n>`, `perf/<n>`. The type drives expectations about which CI workflows run and what kind of approval is required to merge to `staging`.

### Working-branch types

| Type | Owner | Typical content | Merge target |
|---|---|---|---|
| `feature/*` | Developer | New functionality or schema change | `staging` |
| `test/*` | QA | Regression scenarios, e2e harness updates | `staging` |
| `uat/*` | Product / UAT | Behavior verification against business scenarios | `staging` |
| `perf/*` | Perf engineer | Load + latency probes | `staging` (results only; no production code lands from `perf/*`) |

Each type pairs to its own Lakebase branch via the substrate's `createBranch`. Schema changes live on the type's Lakebase branch until the PR merges to `staging`.

### Release-sprint flow

A release proceeds in four ordered phases. Each is intended to be a substrate primitive; the orchestrator composes them with explicit gates.

#### Phase 1: Cut RC from prod

Branch the release candidate from *current* prod (git + Lakebase), NOT from staging.

```
git fetch && git switch prod
git switch -c rc/<release-id>
# substrate creates Lakebase branch paired to rc/<release-id> off prod's Lakebase
```

Then merge staging into the RC. This is where the "things settling on staging" get included or held back:

```
git merge --no-ff staging
# resolve conflicts; remove any commit that should not ship
```

**Why off prod and not off staging?** Cutting from prod locks the release surface. The RC starts from a known-shipped state and adds *only* the changes the release manager actively merges in. Cutting from staging would inherit whatever happens to be on staging, including in-progress work that did not get explicit release sign-off.

#### Phase 2: Regression test the RC

Run the project's full e2e suite against the RC's Lakebase branch.

```
# substrate primitive
lakebase-migrate apply --instance <id> --branch rc/<release-id>
# project's test command
./mvnw test              # or uv run pytest, or npx vitest, ...
```

This is the rehearsal. The RC's Lakebase branch is created from prod's Lakebase, so it carries production's data and the test exercises the migration + behavior against that real shape. The substrate's `applyMigrations` is where Lakebase-specific compatibility (e.g. Flyway's `baselineOnMigrate` flag) lives, in one place.

#### Phase 3: Cut prod-backup

Before touching prod, snapshot it.

```
# substrate primitive
lakebase-cut-backup --instance <id> --branch prod --tag prod-backup-<release-id>
git tag prod-backup-<release-id> prod
git push origin prod-backup-<release-id>
```

**Why a separate backup?** Rollback should be a one-step revert, not a recovery exercise. Cutting the backup *before* the migrate-prod step means the worst-case rollback is `git switch prod && git reset --hard prod-backup-<release-id>` + repoint app config to the snapshot Lakebase branch. Without this step, rolling back means hand-reconstructing prod from the RC + prior tags.

#### Phase 4: Migrate prod

Promote the RC into prod.

```
# substrate primitive
lakebase-migrate apply --instance <id> --branch prod
git switch prod
git merge --ff-only rc/<release-id>
git push origin prod
# app deploy with the new prod sha
```

The substrate's `applyMigrations` applies the same migrations that already ran on the RC in Phase 2, against the real prod Lakebase. Same primitive, same compatibility flags, same code path - the difference is only the target branch.

### Rollback

If the release misbehaves after Phase 4 completes:

```
git switch prod && git reset --hard prod-backup-<release-id>
git push --force-with-lease origin prod
# app: redeploy from prod-backup-<release-id>
# Lakebase: repoint app config at the backup branch (or restore prod from it)
```

Rollback is invasive (it rewrites prod's git history). The convention accepts this cost so that the *common* case (successful release) is simple. If rollback frequency becomes high, the convention should be revisited.

## Consequences

**Positive:**
- Coding agents have a single answer for "where does this work happen": "branch off `staging`, named with the right type prefix."
- Release sequencing is mechanical and reviewable: a check that all four phases ran in order is enough to audit a release.
- Rollback is a known one-step procedure.
- The substrate primitives that will encode this convention are small in number and orthogonal - each phase is a single substrate call.

**Negative:**
- Two long-lived integration branches (`prod`, `staging`) instead of one. Adds merge-management overhead.
- `staging` can drift if not actively curated - merges to staging that the next release doesn't want must be explicitly excluded during Phase 1's `git merge --no-ff staging` step.
- Rollback is invasive (force-push to prod). Teams uncomfortable with rewriting prod's history will need a different rollback model (e.g. revert-forward via a new release).

## Anti-patterns this rules out

- **Cutting the RC from staging.** Loses the "locked surface" property. Anything on staging at branch-time ships, including half-finished work.
- **Merging feature/* directly to prod.** Skips the integration phase; production becomes the de facto integration branch.
- **Running migrations against prod without a backup tag.** Rollback becomes a recovery exercise.
- **Untyped working branches.** Loses the ability to gate CI workflows by type, and loses the ability for an agent to recommend "this should be a `perf/*` branch, not a `feature/*` branch."
- **Multiple concurrent releases sharing a single `prod`.** Phase 1 assumes one in-flight release at a time. Concurrent releases require either a release-tagged variant of this convention or sequencing.

## Future work

Substrate primitives that encode this convention (FEIP-7059 roadmap):

- `bootstrap-branch-convention` - given a fresh project, creates `staging`, `feature`, `test`, `uat`, `perf` from prod (git + Lakebase) and writes parent-pair metadata. One-time per project.
- `cutRC({fromProd, releaseId})` - branches the RC off current prod (git + Lakebase).
- `regressionTest({rc, suite})` - runs the project's full e2e suite against the RC's Lakebase branch.
- `cutBackup({prod, releaseId})` - snapshots current prod's Lakebase branch + writes a git tag.
- `migrateProd({rc, releaseId})` - applies migrations against the prod Lakebase branch + fast-forwards git `prod`.
- `release({releaseId})` - orchestrator. Calls the four phases in order with explicit human-or-policy gates between each.

Companion changes:

- Extension branch picker (VS Code) restricts new-branch creation to the convention's types.
- Scaffolded project YAMLs (`pr.yml`, `merge.yml`) call substrate primitives instead of inlining `mvn flyway:migrate` / `alembic upgrade head` (FEIP-7096).
- Coding-agent skills reference this document as the source for "how do releases work in a Lakebase-paired project."

## Open questions

- **Hotfix path.** This document does not yet describe a "skip staging, urgent fix to prod" path. The convention currently implies all hotfixes go through the full four-phase release. If that proves too slow, an explicit hotfix variant is needed - probably a `hotfix/*` working-branch type that targets a release-candidate cut directly from prod, skipping the staging merge.
- **Multi-environment beyond prod + staging.** Some teams want `dev`, `qa`, `preprod` as additional long-lived branches between staging and prod. This document does not encode that; it can be added as a per-project extension without changing the core convention.
- **Lakebase branch pruning policy.** When `feature/foo` merges to staging, what happens to its Lakebase branch? This document is silent; needs a paired retention policy in the `lakebase-scm-workflows` skill.
