import { describe, it, expect } from "vitest";
import {
  runExperimentsInParallel,
  type ExperimentRunInput,
} from "../../scripts/tdd/parallel-runner";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inputs(count: number, slugPrefix = "exp"): ExperimentRunInput[] {
  return Array.from({ length: count }, (_, i) => ({ slug: `${slugPrefix}-${i + 1}` }));
}

describe("runExperimentsInParallel", () => {
  it("runs every input and produces one result per experiment", async () => {
    const { results } = await runExperimentsInParallel({
      experiments: inputs(5),
      concurrency: 2,
      runner: async (input) => `ran ${input.slug}`,
    });
    expect(results).toHaveLength(5);
    expect(new Set(results.map((r) => r.slug))).toEqual(
      new Set(["exp-1", "exp-2", "exp-3", "exp-4", "exp-5"])
    );
    for (const r of results) {
      expect(r.status).toBe("succeeded");
      if (r.status === "succeeded") {
        expect(r.value).toBe(`ran ${r.slug}`);
      }
    }
  });

  it("honors the concurrency cap (peak_in_flight <= cap)", async () => {
    let observedPeak = 0;
    let inFlight = 0;
    const { peak_in_flight } = await runExperimentsInParallel({
      experiments: inputs(8),
      concurrency: 3,
      runner: async () => {
        inFlight++;
        if (inFlight > observedPeak) observedPeak = inFlight;
        await sleep(20);
        inFlight--;
        return null;
      },
    });
    expect(observedPeak).toBeLessThanOrEqual(3);
    expect(peak_in_flight).toBeLessThanOrEqual(3);
    expect(peak_in_flight).toBeGreaterThanOrEqual(2); // proves it parallelizes
  });

  it("a failure in one experiment does not abort the others", async () => {
    const { results } = await runExperimentsInParallel({
      experiments: inputs(4),
      concurrency: 2,
      runner: async (input) => {
        if (input.slug === "exp-2") throw new Error("boom on exp-2");
        return input.slug;
      },
    });
    expect(results).toHaveLength(4);
    const bySlug = Object.fromEntries(results.map((r) => [r.slug, r]));
    expect(bySlug["exp-1"].status).toBe("succeeded");
    expect(bySlug["exp-2"].status).toBe("failed");
    if (bySlug["exp-2"].status === "failed") {
      expect(bySlug["exp-2"].error.message).toBe("boom on exp-2");
    }
    expect(bySlug["exp-3"].status).toBe("succeeded");
    expect(bySlug["exp-4"].status).toBe("succeeded");
  });

  it("each result carries duration_ms", async () => {
    const { results, total_duration_ms } = await runExperimentsInParallel({
      experiments: inputs(2),
      concurrency: 2,
      runner: async () => {
        await sleep(10);
        return null;
      },
    });
    for (const r of results) {
      expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("empty experiment list returns empty results without invoking the runner", async () => {
    let invoked = false;
    const { results, peak_in_flight } = await runExperimentsInParallel({
      experiments: [],
      concurrency: 4,
      runner: async () => {
        invoked = true;
        return null;
      },
    });
    expect(results).toEqual([]);
    expect(peak_in_flight).toBe(0);
    expect(invoked).toBe(false);
  });

  it("concurrency=1 forces sequential execution (peak_in_flight === 1)", async () => {
    const { peak_in_flight } = await runExperimentsInParallel({
      experiments: inputs(4),
      concurrency: 1,
      runner: async () => {
        await sleep(5);
        return null;
      },
    });
    expect(peak_in_flight).toBe(1);
  });

  it("rejects concurrency < 1", async () => {
    await expect(
      runExperimentsInParallel({
        experiments: inputs(2),
        concurrency: 0,
        runner: async () => null,
      })
    ).rejects.toThrow(/concurrency must be >= 1/);
  });

  it("forwards experiment context through to the runner", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    await runExperimentsInParallel({
      experiments: [
        { slug: "exp-pg", context: { strategy: "postgres-arrays" } },
        { slug: "exp-json", context: { strategy: "json-blob" } },
      ],
      concurrency: 2,
      runner: async (input) => {
        seen.push(input.context);
        return null;
      },
    });
    const strategies = new Set(seen.map((c) => c?.strategy));
    expect(strategies).toEqual(new Set(["postgres-arrays", "json-blob"]));
  });
});
