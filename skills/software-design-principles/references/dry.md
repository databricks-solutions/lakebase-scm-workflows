# DRY — Don't Repeat Yourself

Knowledge has one canonical home. When the same fact, rule, or computation is encoded in two places, those places will drift, and one will silently become wrong.

## What DRY is actually about

DRY is often misread as "avoid duplicate code." It's not. It's "avoid duplicate **knowledge**." Two functions that *look* the same but mean different things are not duplication — they're independent concepts that happen to have isomorphic implementations today.

Knowledge example: the tax rate for California is 7.25%. If that rate is encoded in three modules (invoicing, reporting, the customer-facing quote engine), you have three places to update when it changes, and one of them will be forgotten.

Code-shape example: two API handlers each have a 4-line "parse request, call service, format response" pattern. The shape is similar; the knowledge is not. Trying to DRY this up too early produces a generic dispatcher that obscures the actual handlers.

## The rule of three

Don't extract on the second occurrence. Extract on the third.

- **Occurrence 1:** write it.
- **Occurrence 2:** copy it. Note the duplication mentally.
- **Occurrence 3:** now you know the shape. Extract the abstraction.

Two cases is not enough signal to know which axis of variation matters. The third case reveals which parts are stable (extract) and which vary (parameterize).

Extracting at occurrence 2 is the classic "premature abstraction" smell. You end up with an abstraction shaped like *case 2* that fights case 3 when it arrives.

## When duplication is fine

- **Test data:** repeating "user: alice, email: alice@example.com" across 12 tests is fine. Tests should be readable in isolation; shared fixtures hide what the test actually depends on.
- **Independent domains:** two services in different bounded contexts that happen to have a `User` type. Sharing a "common User" type couples them forever.
- **One-off scripts:** small ad-hoc scripts don't need helpers extracted from other scripts.

## When duplication is a bug

- The same business rule (tax rate, retry count, timeout) is hardcoded in 3+ places.
- The same validation logic is implemented twice and one version is more thorough.
- The same error-handling block appears across many endpoints — likely a cross-cutting concern that should live in middleware.

## DRY versus other principles

- **DRY vs DTSTTCPW:** when you have one caller, prefer DTSTTCPW. Extract only after the third call confirms the abstraction.
- **DRY vs SRP:** sometimes "duplicate code" lives in two modules because they have different responsibilities and just happen to compute similar things. Don't merge them.
- **DRY vs clean code:** a small inline 3-line block is often clearer than a function call to a 20-line helper. Inlining is sometimes the right move.

## The DRY question to ask

"If this fact / rule / formula changes, how many places must I edit?"

- One place → DRY-clean.
- Two places → tolerable if the duplication is visible and the cost of forgetting one is low.
- Three+ places → fix it. You will eventually forget one.
