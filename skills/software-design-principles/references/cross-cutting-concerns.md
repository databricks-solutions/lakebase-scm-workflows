# Cross-cutting concerns

Concerns that span multiple modules — auth, audit, rate limiting, schema validation, capability resolution, policy. The design failure mode is *implementing the same concern in multiple places* and having the implementations drift.

The rule: **each cross-cutting concern has one owner layer and one owner module.** Everything else delegates.

## The mapping (default ownership)

| Concern | Owner layer | Typical module name | Notes |
|---|---|---|---|
| Authentication | HTTP / boundary | `auth/authenticate.ts` | Extracts identity from request (token, session, mTLS). Sets request context. |
| Authorization | Service | `authz/policy.ts` | "Can this identity perform this action on this resource?" Decision lives next to business rules. |
| Capability resolution | Service | `capabilities/resolve.ts` | What the caller is *allowed* to do (independent of any specific action). |
| Audit logging | Cross-cutting (HTTP wraps service) | `audit/emit.ts` | Emitted at service-call boundary so the event captures the domain meaning, not the HTTP shape. |
| Rate limiting | HTTP / boundary | `ratelimit/middleware.ts` | Decided per-request at the edge. |
| Schema validation | HTTP / boundary | `schema/validate.ts` | Reject malformed input before it reaches the service layer. |
| Policy config | Policy layer | `policy/config.ts` | Read-only by HTTP, service, and infrastructure. |
| Transactions | Service | within use-case orchestrators | The use-case decides the boundary; infrastructure executes. |
| Caching | Infrastructure | `cache/` adapters | Cache reads at the repository, never at the service interface. |
| Tracing / metrics | Cross-cutting (HTTP wraps service) | `observability/` | Wraps service calls so spans align with use cases. |
| Secrets resolution | Infrastructure | `secrets/resolve.ts` | Single seam for env / vault / KMS lookups. |
| Feature flags | Policy layer | `flags/eval.ts` | Read at decision points by service layer. |

## Where each concern *should not* live

- **Auth in service:** identity extraction reaches into HTTP-specific request shapes. Wrong layer.
- **Authz in HTTP:** the HTTP layer doesn't know the domain rules. It can check that a token is *valid*; it cannot check that an action is *allowed*.
- **Audit in infrastructure:** infrastructure sees DB calls, not domain events. Auditing "INSERT INTO orders" is less useful than auditing "createOrder."
- **Rate limit in service:** services would have to know the per-route policies. Wrong scope.
- **Schema validation in service:** the service should trust its inputs once the HTTP layer has validated them. Re-validating in service is duplication.

## When a concern needs to span layers

Some concerns *unavoidably* touch multiple layers. The rule then is: **one module owns the concern; other modules delegate via narrow interfaces.**

Example: audit logging
- The HTTP layer wraps the service call.
- The wrapper calls `audit.emit(event)` after the service call returns or throws.
- The audit module formats and writes the event.
- The service does not call `audit.emit()` directly — that's the wrapper's job.

This way: adding a new audit destination touches *one* module; removing audit from a route touches *one* middleware registration.

## The cross-cutting checklist

Before merging a new feature, walk the mapping:

- [ ] Authentication — does this route need it? Where is it enforced?
- [ ] Authorization — is the action gated? Where does the decision live?
- [ ] Capability resolution — does the caller need a capability check?
- [ ] Audit — should this action emit an event? At which boundary?
- [ ] Rate limiting — does this route need a limit?
- [ ] Schema validation — is the input validated? Where?
- [ ] Policy config — does this feature have configuration? Where does it live?
- [ ] Transactions — what's the atomicity boundary?
- [ ] Caching — does this read benefit from a cache?
- [ ] Tracing/metrics — is this operation traced?
- [ ] Secrets — does this feature consume any?
- [ ] Feature flags — is this feature behind a flag?

A row left unanswered is a smell. A row answered "two modules handle it" is a bug waiting to happen.

## When the mapping doesn't fit

The defaults above assume a typical web service. For other shapes (CLI, batch job, MCP server), the boundaries shift:
- **CLI:** the "HTTP layer" is the arg parser. Auth comes from the OS user / env.
- **Batch job:** the "HTTP layer" is the job runner. Auth comes from the runner's identity. Rate limiting becomes "concurrency limit."
- **MCP server:** the "HTTP layer" is the MCP transport (stdio / SSE). Schema validation comes from the tool schema.

The principle is unchanged: each concern has one owner, and that owner lives at the layer with the right scope.
