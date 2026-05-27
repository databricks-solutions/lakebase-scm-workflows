import type { SpecAdapter, AdapterContext, SpecEntity } from "./types";
import type { Feature, Story, AC } from "../spec-sync";

const NOT_IMPLEMENTED = (verb: string) =>
  new Error(`JiraAdapter.${verb} not implemented; wire under FEIP-7167 follow-up`);

export interface JiraAdapterConfig {
  projectKey: string;
  epicKey?: string;
  baseUrl?: string;
}

export class JiraAdapter implements SpecAdapter {
  readonly name = "jira";

  constructor(public readonly config: JiraAdapterConfig) {}

  async pushFeature(_feature: Feature, _ctx: AdapterContext): Promise<{ externalId: string }> {
    throw NOT_IMPLEMENTED("pushFeature");
  }

  async pushStory(_story: Story, _ctx: AdapterContext): Promise<{ externalId: string }> {
    throw NOT_IMPLEMENTED("pushStory");
  }

  async pushAC(_ac: AC, _ctx: AdapterContext): Promise<{ externalId: string }> {
    throw NOT_IMPLEMENTED("pushAC");
  }

  async updateStatus(_externalId: string, _status: string, _ctx: AdapterContext): Promise<void> {
    throw NOT_IMPLEMENTED("updateStatus");
  }

  async pull(_externalId: string, _ctx: AdapterContext): Promise<SpecEntity> {
    throw NOT_IMPLEMENTED("pull");
  }
}
