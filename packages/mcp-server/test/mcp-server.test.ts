import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { ToolRegistry, Workspace, defineTool } from "@codecoach/core";

import { startHttpMcpServer } from "../src/index.js";
import type { RunningMcpServer, ToolHost } from "../src/index.js";

const echo = defineTool({
  name: "echo",
  description: "Echo",
  input: z.object({ value: z.string() }),
  readOnly: true,
  run: async ({ value }) => `echo:${value}`,
});
const l3 = defineTool({
  name: "propose_diff",
  description: "L3 only",
  input: z.object({}),
  levels: ["L3"],
  readOnly: true,
  run: async () => "diff",
});

function host(level: "L0" | "L3"): ToolHost {
  const registry = new ToolRegistry([echo, l3]);
  const workspace = new Workspace(mkdtempSync(path.join(os.tmpdir(), "mcp-")));
  return {
    tools: () => registry.specs(level),
    call: (call) =>
      registry.execute(call, level, { workspace, confirm: async () => false, signal: new AbortController().signal }),
  };
}

let running: RunningMcpServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function connect(server: RunningMcpServer, token = server.token) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  // The SDK's types aren't written for exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return client;
}

describe("MCP server", () => {
  test("lists the level's tools and runs calls through the registry", async () => {
    running = await startHttpMcpServer(host("L0"));
    const client = await connect(running);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object", required: ["value"] });
    expect(await client.callTool({ name: "echo", arguments: { value: "hi" } })).toMatchObject({
      content: [{ type: "text", text: "echo:hi" }],
      isError: false,
    });
    // Invalid input and unknown tools come back as tool errors, as in-process.
    expect(await client.callTool({ name: "echo", arguments: { value: 3 } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "propose_diff", arguments: {} })).toMatchObject({ isError: true });
    await client.close();
  });

  test("L3 lists propose_diff", async () => {
    running = await startHttpMcpServer(host("L3"));
    const client = await connect(running);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo", "propose_diff"]);
    await client.close();
  });

  test("refuses clients without the token and listens only on localhost", async () => {
    running = await startHttpMcpServer(host("L0"));
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await expect(connect(running, "wrong")).rejects.toThrow();
    const res = await fetch(running.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("produces a Claude Code --mcp-config entry", async () => {
    running = await startHttpMcpServer(host("L0"));
    expect(running.mcpConfig()).toEqual({
      mcpServers: {
        codecoach: { type: "http", url: running.url, headers: { Authorization: `Bearer ${running.token}` } },
      },
    });
  });
});
