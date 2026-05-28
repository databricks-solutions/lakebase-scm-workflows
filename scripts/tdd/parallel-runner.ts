// Bounded-concurrency runner for parallel experiment execution.
//
// The orchestrator calls this when phase 4 (Implementation) cuts N>=2
// experiments. Each experiment runs its own cycle loop; this module
// schedules them so the budget's `concurrent_branches` cap is honored
// and a failure in one experiment does NOT abort the others.
//
// The runner is injected so tests stay hermetic (no real Lakebase calls).
// The orchestrator's real runner integrates with experiment.ts +
// run-cycle.ts to drive an actual TDD cycle.

export interface ExperimentRunInput {
  /** Stable identifier — matches an `.tdd/experiments/<F>/<slug>/` dir. */
  slug: string;
  /** Free-form payload the runner can consume (strategy, branch, etc.). */
  context?: Record<string, unknown>;
}

export interface ExperimentRunSuccess<T> {
  slug: string;
  status: "succeeded";
  value: T;
  duration_ms: number;
}

export interface ExperimentRunFailure {
  slug: string;
  status: "failed";
  error: { message: string; stack?: string };
  duration_ms: number;
}

export type ExperimentRunResult<T> = ExperimentRunSuccess<T> | ExperimentRunFailure;

export interface RunExperimentsArgs<T> {
  experiments: ExperimentRunInput[];
  /**
   * Max in-flight experiments. Hard cap honored even when more are queued.
   * Sourced from `.tdd/features/<F>/plan.json` `budget.concurrent_branches`
   * by the orchestrator.
   */
  concurrency: number;
  /** Async runner for one experiment. Errors are caught and reported. */
  runner: (input: ExperimentRunInput) => Promise<T>;
}

export interface RunExperimentsResult<T> {
  results: ExperimentRunResult<T>[];
  total_duration_ms: number;
  /** Peak in-flight count observed during the run. */
  peak_in_flight: number;
}

export async function runExperimentsInParallel<T>(
  args: RunExperimentsArgs<T>
): Promise<RunExperimentsResult<T>> {
  if (args.concurrency < 1) {
    throw new Error(`runExperimentsInParallel: concurrency must be >= 1 (got ${args.concurrency})`);
  }

  const start = Date.now();
  const queue = [...args.experiments];
  const results: ExperimentRunResult<T>[] = [];
  let inFlight = 0;
  let peakInFlight = 0;

  async function worker(): Promise<void> {
    while (true) {
      const exp = queue.shift();
      if (!exp) return;
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      const expStart = Date.now();
      try {
        const value = await args.runner(exp);
        results.push({
          slug: exp.slug,
          status: "succeeded",
          value,
          duration_ms: Date.now() - expStart,
        });
      } catch (err) {
        results.push({
          slug: exp.slug,
          status: "failed",
          error: {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          duration_ms: Date.now() - expStart,
        });
      } finally {
        inFlight--;
      }
    }
  }

  const workerCount = Math.min(args.concurrency, args.experiments.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return {
    results,
    total_duration_ms: Date.now() - start,
    peak_in_flight: peakInFlight,
  };
}
