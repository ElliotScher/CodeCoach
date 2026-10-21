import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ToolCall, ToolResult, ToolSpec } from "@codecoach/core";

/** The MCP server's name; runtimes prefix tool names with it (Claude Code: `mcp__codecoach__read_file`). */
export const SERVER_NAME = "codecoach";

/**
 * Where tool calls actually run. The coach passes its in-process registry, so
 * calls share the workspace sandbox, the coaching state machine and the
 * "lines the coach has read" set the response checker uses.
 */
export interface ToolHost {
  /** Tools for the session's guardrail level (L0 never lists propose_diff). */
  tools(): ToolSpec[];
  call(call: ToolCall): Promise<ToolResult>;
}

export function createMcpServer(host: ToolHost): Server {
  const server = new Server({ name: SERVER_NAME, version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: host.tools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object" as const, ...t.inputSchema },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await host.call({ id: randomUUID(), name: req.params.name, input: req.params.arguments ?? {} });
    return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
  });
  return server;
}

export interface RunningMcpServer {
  url: string;
  /** Bearer token the client must send; the server only listens on 127.0.0.1. */
  token: string;
  /** An `mcpServers` entry for Claude Code's `--mcp-config`. */
  mcpConfig(): { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> };
  close(): Promise<void>;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"] ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Serves the tools over MCP's Streamable HTTP transport on a random local
 * port, for one client (the runtime this coaching session started).
 */
export async function startHttpMcpServer(host: ToolHost): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString("base64url");
  const mcp = createMcpServer(host);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  // The SDK's types aren't written for exactOptionalPropertyTypes; the transport is the SDK's own.
  await mcp.connect(transport as unknown as Parameters<Server["connect"]>[0]);
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req, token)) {
      res.writeHead(401).end();
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    token,
    mcpConfig: () => ({
      mcpServers: { [SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } },
    }),
    close: async () => {
      await mcp.close().catch(() => undefined);
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
