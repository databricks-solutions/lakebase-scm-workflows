# SOLID

The grammar of object-oriented design. Five principles that keep modules small, swappable, and free of accidental coupling. Apply at the module / class boundary, not inside a 20-line function.

## Single Responsibility Principle (SRP)

A module should have one reason to change. If two stakeholders ask for unrelated edits to the same file, that file owns two responsibilities.

**Smell:** `UserService` handles auth, profile editing, audit logging, and email notifications.
**Better:** `Authenticator`, `ProfileEditor`, `AuditLogger`, `Notifier` — each with one reason to change.

The test: name the module's responsibility in one sentence without using "and." If you can't, split it.

## Open-Closed Principle (OCP)

Modules should be open for extension, closed for modification. Add new behavior by adding new code, not by editing existing code.

**Smell:** a `switch (payment.type)` statement that grows a new case every time finance adds a payment method.
**Better:** a `PaymentProcessor` interface; each method ships its own implementation; the dispatcher selects by type registration.

OCP is about reducing the blast radius of change.

## Liskov Substitution Principle (LSP)

Subtypes must be substitutable for their base types without changing program correctness. If a function works with `Bird`, it must work with every subclass of `Bird` — including `Penguin`.

**Smell:** `Penguin extends Bird` but `fly()` throws `NotSupportedException`.
**Better:** rethink the hierarchy. `Bird` and `FlyingBird` are different concepts.

LSP failures usually mean the inheritance was modeling taxonomy, not behavior.

## Interface Segregation Principle (ISP)

Clients should not depend on methods they don't use. A fat interface forces unrelated consumers to share a vocabulary.

**Smell:** `IRepository<T>` with 30 methods, every consumer uses 3 of them.
**Better:** `IReadable<T>`, `IWritable<T>`, `IQueryable<T>` — consumers depend only on what they use.

## Dependency Inversion Principle (DIP)

High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details; details depend on abstractions.

**Smell:** `OrderService` imports `PostgresOrderRepository` directly.
**Better:** `OrderService` depends on an `OrderRepository` interface. `PostgresOrderRepository` implements it. Wiring happens at the composition root.

DIP is what enables: test doubles, multiple storage backends, runtime config swaps, and feature flags that route to different implementations.

## How the five compose

- **SRP + OCP** give you small modules that grow by extension, not edit.
- **LSP + ISP** keep your type hierarchy honest.
- **DIP** wires the small pieces together without creating concrete-dependency knots.

## What SOLID is not

- Not a religion. A 50-line script doesn't need five abstractions.
- Not an excuse for over-abstraction. DTSTTCPW outranks SOLID when you have one caller. (See [dtsttcpw.md](dtsttcpw.md).)
- Not aimed at functions. Functions get clean-code rules (see [clean-code.md](clean-code.md)). SOLID is module-level.

## When to apply

- A module has two stakeholders editing it for unrelated reasons → SRP refactor.
- A switch / if-tree grows every quarter → OCP refactor.
- A subclass throws "not supported" for inherited methods → LSP rethink.
- A consumer imports an interface but uses 10% of it → ISP split.
- A high-level module imports a concrete low-level module by name → DIP injection.
