#!/usr/bin/env node
// lakebase-app-dev-kit MCP server.
//
// Stdio MCP server exposing scripts/lakebase + scripts/github operations
// as MCP tools. Same canonical implementation as the CLI bins and the
// extension – the MCP surface is a third presentation layer over the
// same underlying functions.
//
// Wired into the substrate's `.mcp.json`. Claude Desktop, OpenAI Codex,
// and Cursor (when MCP is preferred over the skill plugin) drive
// lakebase-app-dev-kit through this server.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, findTool } from "./tools.js";

export async function createServer(): Promise<Server> {
  const server = new Server(
    {
      name: "lakebase-app-dev-kit",
      version: "0.2.0-alpha.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdio closes; no further output to stdout (it's the
  // MCP transport). Diagnostic logging must go to stderr.
  process.stderr.write(
    `lakebase-app-dev-kit MCP server ready (${TOOLS.length} tools)\n`
  );
}

// Run only when invoked as a CLI. Importable for tests.
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  main().catch((err) => {
    process.stderr.write(
      `MCP server failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
