---
name: software-design-principles
description: "Foundational engineering canon — SOLID, DRY, DTSTTCPW, clean code, layered architecture, cross-cutting concerns, NFRs. Imported by workflow skills (lakebase-tdd-workflows, lakebase-scm-workflows, lakebase-release-workflows) and project skills that need shared engineering vocabulary. Use when: designing a new module, reviewing a PR, planning a refactor, mapping cross-cutting concerns to layers, or arguing about API shape."
---

# software-design-principles

Shared canon. Read when you need a common engineering vocabulary across roles (Architect, Navigator, Driver, Reviewer) or when a workflow skill points here.

## When to use

- A workflow skill's agent contract instructs you to import this canon (e.g. `lakebase-tdd-workflows` Architect Reviewer requires the layered architecture + cross-cutting concerns mapping).
- You are reviewing or proposing a design and need a reference frame the team agrees on.
- You are about to refactor and want to check that the heuristics still apply.

## What this skill is

A reference, not an executor. It ships markdown only — no scripts. The job is to provide a consistent vocabulary and a checklist of considerations. Workflow skills cite these references; agents read them; humans read them.

## Architectural Concerns Mapping (mandatory before promote/merge)

For any non-trivial change, fill in a mapping table before declaring the design done:

| Concern | Layer | Owner module | Cross-cutting? |
|---|---|---|---|
| Authentication | HTTP / boundary | `<module>` | Yes |
| Authorization | Service | `<module>` | Yes |
| Capability resolution | Service | `<module>` | Yes |
| Audit logging | Cross-cutting | `<module>` | Yes |
| Rate limiting | HTTP / boundary | `<module>` | Yes |
| Schema validation | HTTP / boundary | `<module>` | Yes |
| Policy config | Service / config | `<module>` | Yes |
| Domain logic | Service | `<module>` | No |
| Storage | Infrastructure | `<module>` | No |

If a row is unfilled or a concern doesn't have a clear owner, that's a design smell. Resolve it before merging.

## References

The canon is organized into seven focused references. Each is a short, opinionated document — not a textbook.

- [SOLID](references/solid.md) — Single Responsibility, Open-Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. The grammar of object-oriented design.
- [DRY](references/dry.md) — Don't Repeat Yourself, with the rule-of-three guardrail against premature abstraction.
- [DTSTTCPW](references/dtsttcpw.md) — Do The Simplest Thing That Could Possibly Work. The TDD-aligned counter-balance to speculative generality.
- [Clean code](references/clean-code.md) — Naming, function shape, comment policy, error-handling boundaries. Condensed from Uncle Bob.
- [Layered architecture](references/layered-architecture.md) — Infrastructure / service / HTTP / policy layers, dependency direction rules.
- [Cross-cutting concerns](references/cross-cutting-concerns.md) — Which layer owns auth, authz, capability resolution, audit, rate limiting, schema, policy config.
- [NFRs](references/nfrs.md) — Performance, scalability, security, observability, operability, resilience. The baseline checklist.

## Hard rules

These rules apply across all references. Workflow skills that import this canon inherit them.

1. **Names carry the design.** If a fresh reader can't infer the concept from the name, rename it before the next test.
2. **Layers depend inward, never outward.** HTTP can call service. Service can call infrastructure. Infrastructure never calls service. Service never calls HTTP.
3. **Cross-cutting concerns have one owner.** Two modules with overlapping audit logic is a smell. One owns it; the others delegate.
4. **DRY after three.** Two similar implementations is a coincidence. Three is a pattern — extract.
5. **DTSTTCPW beats speculative generality.** Add the abstraction when the third caller appears, not when you imagine it.
6. **NFR baseline check before declaring done.** Performance / scalability / security / observability / operability / resilience — at least skim the checklist.
7. **Public boundary tests, private implementation refactors.** A correct refactor never changes the outer-boundary tests.

## Composition with workflow skills

- **`lakebase-tdd-workflows`** — Architect Reviewer imports this canon during phase 7.1 (architectural review). Navigator imports during PLAN. Driver imports during REFACTOR.
- **`lakebase-scm-workflows`** — Branch PRs are reviewed against the layered-architecture + cross-cutting-concerns checks.
- **`lakebase-release-workflows`** — NFR baseline checklist is the release gate.

This skill ships no slash commands and no scripts. It is consulted, not invoked.
