import { describe, it, expect } from "vitest";
import { delay } from "../../scripts/util/delay.js";

describe("delay", () => {
  it("resolves after roughly the requested ms (50ms target)", async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;
    // Generous lower bound (timer drift), tight-ish upper bound to catch
    // accidental blocking-spin implementations.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves to undefined", async () => {
    const result = await delay(1);
    expect(result).toBeUndefined();
  });
});
