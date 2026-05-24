#!/usr/bin/env node
// Print the canonical tool registry (apps/mcp-server/tools.ts) as JSON.
// Consumed by scripts/openai-foundry.py to format the same schemas into
// the OpenAI Foundry / Codex tool spec shape, keeps tools.ts as the
// single source of truth for tool surfaces across MCP and Foundry.

import { TOOLS } from "./tools.js";

const dump = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
