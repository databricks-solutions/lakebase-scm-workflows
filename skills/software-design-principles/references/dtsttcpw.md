# DTSTTCPW – Do The Simplest Thing That Could Possibly Work

The TDD counter-balance to speculative generality. Write the code that makes the *current* test pass. No more.

## The rule

When you have a failing test and you're writing code to make it pass: write the smallest, least-clever thing that satisfies the test. No abstraction "for future flexibility." No optional config parameters "because someone might want them." No interface "in case we need to swap implementations."

If a constant satisfies the test, return a constant. (Yes, even that.) The next test will demand variability, and *then* you'll add it.

## Why this is hard to internalize

Programmers who have been burned by under-engineering reach instinctively for abstraction. The lesson "I should have made this configurable" generalizes to "always make things configurable," and now every new module ships with five configuration knobs nobody uses.

DTSTTCPW asks for the discipline to leave the abstraction unbuilt until evidence demands it. The evidence comes from the test list – when the second test introduces variability, *that's* when you parameterize.

## Concrete examples

**Test 1:** "shipping cost for an order under $50 is $5."
**Naive over-engineering:** build a `ShippingCalculator` interface, a `RuleBasedShippingCalculator`, a config-driven rule registry.
**DTSTTCPW:** `return 5;`

**Test 2:** "shipping cost for an order $50 and over is free."
**Naive over-engineering (still):** add the rule registry.
**DTSTTCPW:** `if (order.total >= 50) return 0; return 5;`

**Test 3:** "shipping cost for international orders is $15 flat."
**Now** the abstraction earns its keep. There are three rules with a real shape; extracting `ShippingRule` is informed by three concrete cases instead of speculation.

## DTSTTCPW versus DRY

DTSTTCPW wins until the third occurrence. Two similar pieces of code is not duplication; it's coincidence. DRY at the second occurrence locks in a shape that will fight the third case.

## DTSTTCPW versus SOLID

SOLID is about module-level shape *once you have enough use cases to know what the module is*. DTSTTCPW keeps you from inventing modules before that signal arrives. A 200-line script with no abstractions is fine when there's one caller; the same script split into eight tiny interfaces is over-engineered if there's still only one caller.

## What "honest" means

The full rule is "minimal *honest* code." Honesty rules out shortcuts that satisfy the *current* test but contradict the *test list*. If the list has 10 tests and you can see test #5 will demand a hash map, you don't need to *build* the hash map at test #1 – but you shouldn't write code at test #1 that knowingly breaks at test #5 either.

The horizon is the test list, not the current test. The increment is one test at a time.

## When NOT to apply DTSTTCPW

- **At system boundaries.** Public APIs, file formats, database schemas – these are hard to change. Speculate carefully *here*, because the cost of unwinding the wrong choice is high.
- **At known integration points.** If you already know you'll need to call a payment provider, don't write a stub that hardcodes "Stripe." Use an interface from day one.
- **For safety-critical paths.** Auth, authz, audit – these need the right abstraction up front because the cost of getting them wrong is severe.

For internal logic, default to DTSTTCPW. For boundaries, design carefully.

## The DTSTTCPW question

"Is there a smaller change that makes the failing test pass?"

If yes, take it. The abstraction you're tempted to write is a *speculation*. Let the next test confirm or refute it.
