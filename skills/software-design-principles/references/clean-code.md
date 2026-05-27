# Clean code

Condensed Uncle Bob principles, grounded in TDD practice. Naming, function shape, comments, error handling.

## Naming carries the design

The name is the API. A reader who can't infer the concept from the name has to read the body. A reader who reads the body is now coupled to your implementation.

- Names should be pronounceable, searchable, intention-revealing.
- Don't encode types (`strName`, `iCount`). The compiler already knows.
- Don't abbreviate to "save typing." `customerOrderProcessor` beats `custOrdProc`.
- Names at the boundary should match the domain vocabulary, not your internal model.

After every GREEN: "would a fresh reader infer the right concept from this name?" If not, rename before the next test.

## Functions are small

- One screen, ideally <20 lines.
- One level of abstraction per function. Don't mix high-level orchestration with low-level string parsing in the same body.
- A function should "do one thing." If you can extract a section and give it a meaningful name, it was doing two things.
- Argument count: 0 ideal, 1 fine, 2 acceptable, 3+ suspicious. Past 3, group related args into an object.
- Output arguments (mutating inputs) are anti-patterns. Return new values.

## Comments

Comments rot. Code doesn't. Optimize for code that doesn't need comments.

When to comment:
- Non-obvious *why*: a workaround for a specific bug, a hidden invariant, a contract that the caller must uphold.
- Public API documentation (JSDoc, docstring) where it shows up in tooling.
- TODO / FIXME with a ticket number.

When *not* to comment:
- To explain *what* the code does — rename the function/variable instead.
- To explain *how* the code works — extract a helper with a clear name.
- To narrate the developer's process ("first we get the user, then we check perms").
- To restate the obvious (`// increment counter` next to `counter++`).
- To mark removed code ("// removed X because Y"). Use git history.

A comment that would confuse a reader if removed deserves to exist. A comment whose removal nobody would notice is noise.

## Error handling at boundaries

- Validate at the system boundary (HTTP handler, CLI entry, message consumer).
- Once past the boundary, trust your own types.
- Never silently swallow exceptions. At minimum log; ideally re-throw with context.
- Don't `try/catch` for control flow. Exceptions are for *exceptional* conditions.
- The "happy path" of a function should be visually obvious — error handling is the indented or guarded path.

Guard clauses beat nested ifs:

```ts
// good
if (!user) return errorResponse(401);
if (!user.active) return errorResponse(403);
return doTheWork(user);

// less good
if (user) {
  if (user.active) {
    return doTheWork(user);
  } else {
    return errorResponse(403);
  }
} else {
  return errorResponse(401);
}
```

## Module shape

- Public surface small, private internals as large as needed.
- One concept per file. If `userService.ts` also contains an unrelated helper, move the helper.
- File order: types and constants → public functions (top-down) → private helpers → exports.
- Cyclic imports are a design smell. Break the cycle by extracting a third module.

## Tests are code too

Clean-code rules apply to tests:
- Clear names that read like specifications (`it("rejects login when the password is wrong")`).
- One assertion per test, ideally. If you need three, the test is doing three things.
- No magic numbers — use named constants or fixture factories.
- AAA structure (Arrange / Act / Assert) is visible by indentation.
- Test fixtures are data — repeat freely, don't over-factor.

## The cleanest code question

"Could I delete this and the system would still work?" If yes, delete it. Unused code rots faster than used code.
