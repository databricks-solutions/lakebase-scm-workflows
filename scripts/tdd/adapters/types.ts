import type { Feature, Story, AC } from "../spec-sync";

export type SpecEntity = Feature | Story | AC;
export type Status = string;

export interface AdapterContext {
  tddDir: string;
  config?: Record<string, unknown>;
}

export interface SyncEventHooks {
  /**
   * Called by the Scrum-Master after a workflow phase transitions.
   * Failures are logged + surfaced but must not block the workflow.
   */
  onPhaseTransition?(prev: string, next: string, ctx: AdapterContext): Promise<void> | void;
  /** Called after a TDD cycle artifact is persisted (RED / GREEN / REFACTOR boundary). */
  onCycleComplete?(cycleId: string, ctx: AdapterContext): Promise<void> | void;
  /** Called when a bad smell is detected; payload carries the smell name + arbitrary detail. */
  onSmellDetected?(smellName: string, detail: unknown, ctx: AdapterContext): Promise<void> | void;
}

export interface SpecAdapter extends SyncEventHooks {
  readonly name: string;

  pushFeature(feature: Feature, ctx: AdapterContext): Promise<{ externalId: string }>;
  pushStory(story: Story, ctx: AdapterContext): Promise<{ externalId: string }>;
  pushAC(ac: AC, ctx: AdapterContext): Promise<{ externalId: string }>;

  updateStatus(externalId: string, status: Status, ctx: AdapterContext): Promise<void>;

  pull(externalId: string, ctx: AdapterContext): Promise<SpecEntity>;
}
