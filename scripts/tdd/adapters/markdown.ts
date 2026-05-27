import type { SpecAdapter, AdapterContext, SpecEntity } from "./types";
import type { Feature, Story, AC } from "../spec-sync";

export class MarkdownAdapter implements SpecAdapter {
  readonly name = "markdown";

  async pushFeature(feature: Feature, _ctx: AdapterContext): Promise<{ externalId: string }> {
    return { externalId: `markdown:${feature.id}` };
  }

  async pushStory(story: Story, _ctx: AdapterContext): Promise<{ externalId: string }> {
    return { externalId: `markdown:${story.id}` };
  }

  async pushAC(ac: AC, _ctx: AdapterContext): Promise<{ externalId: string }> {
    return { externalId: `markdown:${ac.id}` };
  }

  async updateStatus(_externalId: string, _status: string, _ctx: AdapterContext): Promise<void> {
    return;
  }

  async pull(externalId: string, _ctx: AdapterContext): Promise<SpecEntity> {
    throw new Error(`MarkdownAdapter.pull is a no-op: ${externalId} is sourced from the on-disk spec`);
  }
}

export const markdownAdapter: SpecAdapter = new MarkdownAdapter();
