# NFRs — non-functional requirements

The baseline checklist. Walk before declaring a feature done. Each row asks "what's the answer here, even if the answer is 'good enough'?"

A blank row is fine when scope justifies it. An *unconsidered* row is a smell.

## The six categories

### 1. Performance

- **Expected latency at p50 / p95 / p99?** Even an order-of-magnitude estimate beats nothing.
- **Throughput requirement** (requests/sec, items/min)?
- **Largest input the system must handle?** (largest file, longest list, deepest nesting)
- **Hot paths identified?** Is there a measurement that would catch a 10x regression?

Common smells:
- "It'll be fine" with no measurement.
- An N+1 query that nobody noticed because the dev set has 10 rows.
- A loop that copies a large list on each iteration.

### 2. Scalability

- **Horizontal:** can you add a second instance? What state is shared?
- **Vertical:** what's the limiting resource (CPU / memory / disk / I/O)?
- **Data growth:** does the design handle 10x / 100x today's data volume?
- **Backpressure:** what happens when an upstream slows down? Queue, drop, retry?

Common smells:
- In-memory cache assumes one process.
- Background job runs every N minutes; doesn't degrade gracefully under load.
- "We'll worry about scale later" — but the data model can't grow.

### 3. Security

- **AuthN/AuthZ:** is the boundary protected? See [cross-cutting-concerns.md](cross-cutting-concerns.md) for ownership.
- **Input validation:** anywhere user input crosses a trust boundary, validated?
- **Secrets:** any hardcoded? Logged? Committed to git?
- **PII:** identified? Stored where? Retention policy?
- **Dependency hygiene:** are any deps known-vulnerable?

Common smells:
- A token logged on error.
- A regex used for security validation. (Regex is for shape; auth is decisions.)
- An admin endpoint with no extra check beyond "authenticated."

### 4. Observability

- **Logs:** structured, correlation-id, level-appropriate?
- **Metrics:** at least request count, error rate, latency histogram per endpoint / job?
- **Traces:** spans for cross-service / cross-layer calls?
- **Alerts:** what's the symptom-based alert? (Not "CPU high" — "checkout success rate dropped.")

Common smells:
- A feature ships with `console.log("ok")` as its only signal.
- An alert that fires nightly because nobody owns it.
- Logs that say "error happened" with no context.

### 5. Operability

- **Deployment:** how does this ship? Idempotent? Rollback story?
- **Configuration:** how is it changed without redeploy? See [layered-architecture.md](layered-architecture.md) policy layer.
- **Diagnostics:** if it's broken at 3am, what's the first thing an operator looks at?
- **Runbook:** any operational steps that aren't obvious?

Common smells:
- A feature flag that requires a redeploy to flip.
- A "just restart it" answer to every kind of failure.
- A new endpoint with no entry in the health check.

### 6. Resilience

- **Retries:** which calls retry? With what backoff?
- **Timeouts:** every external call has one?
- **Idempotency:** writes designed to handle duplicate delivery?
- **Degraded mode:** if dependency X is down, what still works?
- **Recovery:** if state corrupts, can it be rebuilt?

Common smells:
- An external API call with no timeout — hangs forever on a slow upstream.
- A retry loop with no backoff — DDoSes the upstream when it returns.
- A write that doubles a counter if delivered twice.

## How to apply the checklist

This is not a 200-item compliance form. It's a 10-minute conversation:

1. Read the six categories.
2. For each, name the answer in one sentence — even "no requirement here" is a valid answer.
3. If you can't answer in one sentence, note it as a follow-up.

The cost of skipping the check is finding the gap in production. The cost of running the check is 10 minutes.

## When the checklist sets a release gate

In `lakebase-release-workflows`, the NFR baseline is the release gate before promote-to-prod. Each row must have an answer recorded in the release ticket (or an explicit "N/A — reason").

That's not bureaucracy. It's the audit trail when something breaks in production and the question "did anyone think about this" needs an answer.

## NFRs and feature-level work

In `lakebase-tdd-workflows`, every feature's `feature.json` carries an `nfrs[]` array. The Architect Reviewer is required to populate it during phase 7.1. Empty is allowed; unaddressed is not.

The principle: design intent is captured before the test list, not bolted on at the end.
