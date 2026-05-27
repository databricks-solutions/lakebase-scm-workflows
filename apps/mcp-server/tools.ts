// Tool registry for the lakebase-app-dev-kit MCP server.
//
// Each tool wraps a script module function (NOT a subprocess). The MCP
// server exposes these by name + JSON Schema; an MCP-capable agent
// (Claude Desktop, OpenAI Codex, Cursor-via-MCP) reads the schema,
// validates user input, and invokes the handler over stdio.
//
// The tool list is the same five-target reach surface documented in the
// repo README; CLI behavior is in scripts/lakebase/<verb>.cli.ts, the
// canonical implementations these tools delegate to live in the matching
// non-.cli files.

import { getConnection } from "../../scripts/lakebase/get-connection.js";
import { getSchemaDiff } from "../../scripts/lakebase/schema-diff.js";
import { createProject, type CreateProjectArgs } from "../../scripts/lakebase/create-project.js";
import { resolveGitHubToken, diagnoseGitHubAuth } from "../../scripts/github/auth.js";
import {
  applyMigrations,
  rollbackMigration,
  migrationStatus,
  listMigrations,
  type MigrationLanguage,
} from "../../scripts/lakebase/migrate.js";
import { getFeatureStatus } from "../../scripts/tdd/feature-status.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`'${key}' is required`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "lakebase_get_connection",
    description:
      "Mint a Postgres DSN string for a Lakebase branch. Single-seam credential handoff: this is the only path that mints Lakebase credentials.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Lakebase project (instance) id." },
        branch: { type: "string", description: "Branch id within the project." },
        endpointName: {
          type: "string",
          description: "Endpoint identifier on the branch. Default: 'primary'.",
        },
        database: {
          type: "string",
          description: "Database name. Default: $PGDATABASE or 'databricks_postgres'.",
        },
      },
      required: ["instance", "branch"],
      additionalProperties: false,
    },
    handler: async (args) => {
      return await getConnection({
        output: "dsn",
        instance: requireString(args, "instance"),
        branch: requireString(args, "branch"),
        endpointName: optionalString(args, "endpointName"),
        database: optionalString(args, "database"),
      });
    },
  },
  {
    name: "lakebase_schema_diff",
    description:
      "Parent-aware schema diff between two Lakebase branches. If 'against' is omitted, parent is resolved from Lakebase metadata (sourceBranchId, falling back to the project's default branch).",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Lakebase project (instance) id." },
        branch: { type: "string", description: "Target branch to diff FOR." },
        against: {
          type: "string",
          description: "Explicit parent branch. Default: resolved from metadata.",
        },
        database: {
          type: "string",
          description: "Database name. Default: $PGDATABASE or 'databricks_postgres'.",
        },
      },
      required: ["instance", "branch"],
      additionalProperties: false,
    },
    handler: async (args) => {
      return await getSchemaDiff({
        instance: requireString(args, "instance"),
        branch: requireString(args, "branch"),
        comparisonBranch: optionalString(args, "against"),
        database: optionalString(args, "database"),
      });
    },
  },
  {
    name: "lakebase_github_token",
    description:
      "Resolve a GitHub token via the unified fallback chain (GITHUB_TOKEN env → VS Code session → gh auth token). Use 'diagnose: true' to inspect which sources are available WITHOUT revealing the token value.",
    inputSchema: {
      type: "object",
      properties: {
        diagnose: {
          type: "boolean",
          description:
            "If true, return { sources, primary, scopes } instead of the token itself. Safe to log.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (args.diagnose === true) {
        return await diagnoseGitHubAuth();
      }
      const token = await resolveGitHubToken();
      const { primary } = await diagnoseGitHubAuth();
      return { token, source: primary };
    },
  },
  {
    name: "lakebase_create_project",
    description:
      "Bootstrap a fresh Lakebase-paired project end-to-end: Lakebase project + parent branch, GitHub repo (optional), Actions runner, repo secrets, local scaffold.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string", description: "Project name (Lakebase id + local dir)." },
        parentDir: { type: "string", description: "Parent directory for the new project dir." },
        databricksHost: {
          type: "string",
          description: "Databricks workspace URL (https://....cloud.databricks.com).",
        },
        githubOwner: {
          type: "string",
          description: "GitHub user/org for the repo. Required unless createGithubRepo=false.",
        },
        createGithubRepo: {
          type: "boolean",
          description: "Create a GitHub repo? Default: true.",
        },
        privateRepo: {
          type: "boolean",
          description: "Make the GitHub repo private? Default: true.",
        },
        language: {
          type: "string",
          enum: ["java", "kotlin", "python", "nodejs"],
          description: "Project language. Default: 'java'.",
        },
        runnerType: {
          type: "string",
          enum: ["self-hosted", "github-hosted"],
          description: "Actions runner mode. Default: 'self-hosted'.",
        },
      },
      required: ["projectName", "parentDir", "databricksHost"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input: CreateProjectArgs = {
        projectName: requireString(args, "projectName"),
        parentDir: requireString(args, "parentDir"),
        databricksHost: requireString(args, "databricksHost"),
        githubOwner: optionalString(args, "githubOwner"),
        createGithubRepo: typeof args.createGithubRepo === "boolean" ? args.createGithubRepo : undefined,
        privateRepo: typeof args.privateRepo === "boolean" ? args.privateRepo : undefined,
        language: optionalString(args, "language") as CreateProjectArgs["language"],
        runnerType: optionalString(args, "runnerType") as CreateProjectArgs["runnerType"],
      };
      return await createProject(input);
    },
  },
  {
    name: "lakebase_list_migrations",
    description:
      "Enumerate migration files on disk for a paired project. No DB connection. Auto-detects language (java/kotlin via pom.xml + Flyway, python via pyproject.toml/alembic.ini + Alembic, nodejs via package.json + Knex).",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string", description: "Project root. Default: cwd of the MCP server." },
        language: {
          type: "string",
          enum: ["java", "kotlin", "python", "nodejs"],
          description: "Override language detection.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      return listMigrations({
        projectDir: optionalString(args, "projectDir"),
        language: optionalString(args, "language") as MigrationLanguage | undefined,
      });
    },
  },
  {
    name: "lakebase_apply_migrations",
    description:
      "Apply pending forward migrations against a Lakebase branch. Python/Alembic supported today; Java+Kotlin/Flyway (FEIP-7098) and Node/Knex (FEIP-7099) error with a clear pointer until those runners land.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Lakebase project (instance) id." },
        branch: { type: "string", description: "Branch to migrate against." },
        projectDir: { type: "string", description: "Project root. Default: cwd." },
        language: {
          type: "string",
          enum: ["java", "kotlin", "python", "nodejs"],
          description: "Override language detection.",
        },
        database: { type: "string", description: "Database name. Default: $PGDATABASE or 'databricks_postgres'." },
        endpointName: { type: "string", description: "Endpoint identifier on the branch. Default: 'primary'." },
      },
      required: ["instance", "branch"],
      additionalProperties: false,
    },
    handler: async (args) => {
      return applyMigrations({
        instance: requireString(args, "instance"),
        branch: requireString(args, "branch"),
        projectDir: optionalString(args, "projectDir"),
        language: optionalString(args, "language") as MigrationLanguage | undefined,
        database: optionalString(args, "database"),
        endpointName: optionalString(args, "endpointName"),
      });
    },
  },
  {
    name: "lakebase_rollback_migration",
    description:
      "Roll back applied migrations on a Lakebase branch down to a target version. Python/Alembic only today (Flyway Community does not support rollback; Node/Knex via FEIP-7099). For Alembic, 'target' can be a revision id or a relative step like '-1'.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Lakebase project (instance) id." },
        branch: { type: "string", description: "Branch to roll back." },
        target: { type: "string", description: "Revision id or relative step (e.g., '-1' for one step down)." },
        projectDir: { type: "string", description: "Project root. Default: cwd." },
        language: {
          type: "string",
          enum: ["java", "kotlin", "python", "nodejs"],
          description: "Override language detection.",
        },
        database: { type: "string", description: "Database name. Default: $PGDATABASE or 'databricks_postgres'." },
        endpointName: { type: "string", description: "Endpoint identifier on the branch. Default: 'primary'." },
      },
      required: ["instance", "branch", "target"],
      additionalProperties: false,
    },
    handler: async (args) => {
      return rollbackMigration({
        instance: requireString(args, "instance"),
        branch: requireString(args, "branch"),
        target: requireString(args, "target"),
        projectDir: optionalString(args, "projectDir"),
        language: optionalString(args, "language") as MigrationLanguage | undefined,
        database: optionalString(args, "database"),
        endpointName: optionalString(args, "endpointName"),
      });
    },
  },
  {
    name: "lakebase_migration_status",
    description:
      "Report the currently-applied migration version and the list of pending migrations for a Lakebase branch.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Lakebase project (instance) id." },
        branch: { type: "string", description: "Branch to inspect." },
        projectDir: { type: "string", description: "Project root. Default: cwd." },
        language: {
          type: "string",
          enum: ["java", "kotlin", "python", "nodejs"],
          description: "Override language detection.",
        },
        database: { type: "string", description: "Database name. Default: $PGDATABASE or 'databricks_postgres'." },
        endpointName: { type: "string", description: "Endpoint identifier on the branch. Default: 'primary'." },
      },
      required: ["instance", "branch"],
      additionalProperties: false,
    },
    handler: async (args) => {
      return migrationStatus({
        instance: requireString(args, "instance"),
        branch: requireString(args, "branch"),
        projectDir: optionalString(args, "projectDir"),
        language: optionalString(args, "language") as MigrationLanguage | undefined,
        database: optionalString(args, "database"),
        endpointName: optionalString(args, "endpointName"),
      });
    },
  },
  {
    name: "lakebase_feature_status",
    description:
      "One-screen snapshot of a feature's TDD workflow state (phase, plan, test-list completion, experiments, recent decisions, open smells). Reads .tdd/ on disk; no Lakebase or network calls. See skills/lakebase-tdd-workflows/references/feature-status-schema.md for the stable payload contract.",
    inputSchema: {
      type: "object",
      properties: {
        featureId: { type: "string", description: "Feature id (e.g., 'F1-checkout')." },
        tddDir: { type: "string", description: "Path to the .tdd/ directory. Default: './.tdd'." },
      },
      required: ["featureId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      return getFeatureStatus(
        optionalString(args, "tddDir") ?? "./.tdd",
        requireString(args, "featureId")
      );
    },
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
