# Layered architecture

A way to decide where code lives. Dependencies point inward; cross-cutting concerns have one owner per layer.

## The four layers

1. **HTTP / Boundary layer** – the outermost edge. Accepts requests (HTTP, CLI args, message queue events), validates input shape, returns responses. Knows the wire format. Does *not* contain business logic.
2. **Service layer** – business logic. Owns the domain model. Coordinates infrastructure calls. Knows nothing about HTTP, headers, status codes.
3. **Infrastructure layer** – talks to the outside world. Database, object store, external APIs, file system, secrets. Returns domain types to the service layer.
4. **Policy / Config layer** – declarative rules: feature flags, environment-specific limits, capability matrices. Read by the layers above; never reaches into them.

## Dependency direction (the cardinal rule)

```
HTTP    →    Service    →    Infrastructure
                ↑
              Policy
```

- HTTP imports Service. Service does NOT import HTTP.
- Service imports Infrastructure. Infrastructure does NOT import Service.
- Policy is read by any layer. Policy does NOT import any layer.

If you find an `import express` in your service layer, that's a violation. If your infrastructure code knows about HTTP status codes, that's a violation.

## What goes in each layer

**HTTP / Boundary:**
- Request parsing, schema validation (zod, ajv, etc.)
- Auth header extraction (not auth decisions – those are policy/service)
- Response shaping, content-negotiation
- Rate limiting
- CORS / security headers
- Error translation (domain errors → HTTP status codes)

**Service:**
- Use-case orchestration ("createOrder", "approveLeave")
- Domain rules and invariants
- Transaction boundaries
- Capability resolution ("can this user perform this action?")
- Audit event emission

**Infrastructure:**
- Repository implementations (Postgres, S3, etc.)
- External API clients (Stripe, SendGrid, etc.)
- Secret resolution
- File system access
- Message queue producers/consumers

**Policy / Config:**
- Feature flags
- Per-environment limits (timeouts, retries, batch sizes)
- Capability matrices (role → allowed actions)
- Schema definitions consumed by validation layers

## Why this works

- **Testability:** the service layer can be unit-tested with infrastructure fakes. The HTTP layer can be integration-tested with a fake service. Each layer has a narrow seam.
- **Swappability:** moving from Postgres to MySQL touches infrastructure only.
- **Reasoning:** when a bug appears in a request flow, you know which layer to inspect first based on the symptom.
- **Cross-cutting concerns:** each concern has a clear owner layer (see [cross-cutting-concerns.md](cross-cutting-concerns.md)).

## Common violations and fixes

**Violation:** service layer returns `{ statusCode: 404, body: "Not found" }`.
**Fix:** service throws / returns a domain error; HTTP layer maps domain errors to HTTP codes.

**Violation:** HTTP handler queries the database directly.
**Fix:** HTTP calls service; service calls repository.

**Violation:** infrastructure module reads `process.env` directly.
**Fix:** infrastructure receives config via constructor injection; reading env is a composition-root concern.

**Violation:** circular import between service and infrastructure.
**Fix:** extract the shared type to a third module (often `domain/types.ts`).

## What about microservices

Layered architecture is intra-service. In a microservices system, each service has its own layered structure. Inter-service communication happens through the HTTP / boundary layer of each.

Don't confuse "microservice" with "layer." A microservice still needs HTTP, service, infrastructure, and policy internally.

## What about "hexagonal" / "clean" / "onion" architecture

These are refinements of layered architecture that emphasize ports + adapters. The dependency rule (dependencies point inward) is the shared core. For most systems, the four-layer mental model above is sufficient.

If your domain is complex enough that you need ports and adapters, you'll know – but reach for the more elaborate model when the simple one strains, not before. (DTSTTCPW applies here too.)

## The layered-architecture check

When you add a new file: which layer is it in? If you can't answer in one word (HTTP / service / infrastructure / policy), the file is doing too many things.
