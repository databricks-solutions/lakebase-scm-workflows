// Integration test: spawn the built MCP server bin and walk the real
// stdio JSON-RPC handshake (initialize → list_tools → call_tools).
//
// Proves the wire format is correct end-to-end. The handler-level test
// (tools.test.ts) covers handler logic with mocks; this one covers the
// MCP envelope. Uses lakebase_github_token diagnose-mode because it has
// no required args and (after stubbing the auth resolvers via env)
// never touches the network.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = resolve(__dirname, "../../dist/apps/mcp-server/index.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private buffer = "";
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private nextId = 1;

  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
  }

  private onData(s: string) {
    this.buffer += s;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const cb = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg);
      }
    }
  }

  async request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<JsonRpcResponse>((resolveResp, reject) => {
      this.pending.set(id, resolveResp);
      this.child.stdin.write(payload + "\n", (err) => err && reject(err));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for ${method} (id=${id})`));
        }
      }, 5000);
    });
  }

  notify(method: string, params: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin.write(payload + "\n");
  }
}

describe("MCP server stdio handshake", () => {
  if (!existsSync(SERVER_PATH)) {
    it.skip("dist not built – run `npm run build` to enable handshake test", () => {});
    return;
  }

  let child: ChildProcessWithoutNullStreams;
  let client: McpClient;

  beforeAll(() => {
    child = spawn("node", [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GITHUB_TOKEN: "ghs_TEST_HANDSHAKE_TOKEN" },
    });
    client = new McpClient(child);
  });

  afterAll(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("initialize → tools/list → tools/call works end-to-end", async () => {
    const initResp = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-handshake", version: "0.0.0" },
    });
    expect(initResp.result).toMatchObject({
      serverInfo: { name: "lakebase-app-dev-kit" },
    });
    client.notify("notifications/initialized", {});

    const listResp = await client.request("tools/list", {});
    const tools = (listResp.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "lakebase_create_project",
      "lakebase_get_connection",
      "lakebase_github_token",
      "lakebase_schema_diff",
    ]);

    const callResp = await client.request("tools/call", {
      name: "lakebase_github_token",
      arguments: { diagnose: true },
    });
    const content = (callResp.result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toHaveProperty("sources");
    expect(parsed.sources).toContain("env");
    expect(parsed).not.toHaveProperty("token");
  });
});
