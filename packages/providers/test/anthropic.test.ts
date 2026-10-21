import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";

import type { ChatEvent, ChatRequest, Message } from "@codecoach/core";

import {
  AnthropicProvider,
  ApiSpendingDisabledError,
  buildRequest,
  toAnthropicMessages,
  toProviderError,
} from "../src/index.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** A provider whose HTTP layer replays SSE fixtures and records each request. */
function replaying(...responses: (string | { status: number; body: unknown })[]) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const queue = [...responses];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    const next = queue.shift();
    if (next === undefined) throw new Error("no fixture left");
    if (typeof next !== "string") {
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = new AnthropicProvider({
    client: { apiKey: "test-key", fetch: fetchImpl as typeof fetch, maxRetries: 0 },
    allowApiSpend: true, // mocked fetch: nothing is billed
  });
  return { provider, requests };
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const request = (messages: Message[]): ChatRequest => ({
  model: "claude-opus-5-5",
  effort: "medium",
  system: [
    { text: "persona and rules", cacheBreakpoint: true },
    { text: "project summary", cacheBreakpoint: true },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ],
  messages,
});

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const sys = (text: string): Message => ({ role: "system", content: [{ type: "text", text }] });

describe("AnthropicProvider request shape", () => {
  test("system cache breakpoints, eager tools, adaptive thinking, effort and fallbacks", () => {
    const body = buildRequest(request([user("hi"), sys("phase: describe")]), { fallbacks: true });
    expect(body.system).toEqual([
      { type: "text", text: "persona and rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "project summary", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.tools?.[0]).toMatchObject({ name: "read_file", eager_input_streaming: true });
    expect(body).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tool_choice: { type: "auto" },
      max_tokens: 64000,
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
  });

  test("no fallbacks for models without server-side fallback", () => {
    const body = buildRequest({ ...request([user("x")]), model: "claude-haiku-5-5" }, { fallbacks: true });
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("betas");
  });

  test("per-turn context goes in a mid-conversation system message; the user turn carries the cache breakpoint", () => {
    const msgs = toAnthropicMessages([user("robot won't drive"), sys("phase: describe")]);
    expect(msgs).toEqual([
      { role: "user", content: [{ type: "text", text: "robot won't drive", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "phase: describe" },
    ]);
  });

  test("replays raw assistant content unchanged and maps tool results", () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
    ];
    const msgs = toAnthropicMessages([
      user("q"),
      {
        role: "assistant",
        content: [{ type: "tool_call", call: { id: "t1", name: "read_file", input: { path: "a" } } }],
        raw: { provider: "anthropic", data: { content: raw } },
      },
      { role: "user", content: [{ type: "tool_result", result: { callId: "t1", content: "nope", isError: true } }] },
    ]);
    expect(msgs[1]).toEqual({ role: "assistant", content: raw });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "nope",
          is_error: true,
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  test("assistant turns from other providers fall back to the neutral form", () => {
    const msgs = toAnthropicMessages([
      user("q"),
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        raw: { provider: "openai", data: { whatever: 1 } },
      },
    ]);
    expect(msgs[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });
});

describe("AnthropicProvider streaming (recorded SSE)", () => {
  test("a tool-use turn then a text turn: text deltas, tool calls, usage and a cache read on turn 2", async () => {
    const { provider, requests } = replaying(fixture("turn1-tool-use.sse"), fixture("turn2-text.sse"));
    const t1 = await collect(
      provider.stream(request([user("robot won't drive"), sys("phase: describe")]), new AbortController().signal),
    );
    expect(
      t1
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Let me look at your code.");
    expect(t1.find((e) => e.type === "tool_call")).toEqual({
      type: "tool_call",
      call: { id: "toolu_01", name: "read_file", input: { path: "src/main/java/frc/robot/RobotContainer.java" } },
    });
    const end1 = t1.at(-1) as Extract<ChatEvent, { type: "turn_end" }>;
    expect(end1).toMatchObject({
      stop: "tool_use",
      usage: { cacheWriteTokens: 1800, cacheReadTokens: 0, outputTokens: 62 },
    });
    // The raw content (including the thinking block) is kept for replay.
    expect((end1.raw as { content: { type: string }[] }).content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);

    const history: Message[] = [
      user("robot won't drive"),
      sys("phase: describe"),
      { role: "assistant", content: [], raw: { provider: "anthropic", data: end1.raw } },
      {
        role: "user",
        content: [{ type: "tool_result", result: { callId: "toolu_01", content: "file text", isError: false } }],
      },
    ];
    const t2 = await collect(provider.stream(request(history), new AbortController().signal));
    expect(t2.at(-1)).toMatchObject({ type: "turn_end", stop: "end_turn", usage: { cacheReadTokens: 1800 } });

    expect(requests[0]!.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(requests[0]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    // Append-only: turn 2's request starts with turn 1's messages, byte for byte.
    const m1 = requests[0]!.body["messages"] as unknown[];
    const m2 = requests[1]!.body["messages"] as unknown[];
    expect(JSON.stringify(m2[1])).toBe(JSON.stringify(m1[1]));
    expect(m2[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "thinking", signature: "sig-abc" }, { type: "text" }, { type: "tool_use" }],
    });
    expect(JSON.stringify(requests[1]!.body["system"])).toBe(JSON.stringify(requests[0]!.body["system"]));
    expect(JSON.stringify(requests[1]!.body["tools"])).toBe(JSON.stringify(requests[0]!.body["tools"]));
  });

  test("refusals end the turn without tool calls", async () => {
    const { provider } = replaying(fixture("refusal.sse"));
    const events = await collect(provider.stream(request([user("x")]), new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn_end",
      stop: "refusal",
      error: { kind: "refusal", message: "Declined (cyber)." },
    });
  });

  test("malformed tool JSON comes back as a silently truncated input", async () => {
    // The SDK's tolerant partial-JSON parser doesn't throw here: it returns a
    // truncated object. That's why every tool input is validated with Zod in
    // the registry, and why turns stopped at max_tokens never run their tools.
    // (Input it can't parse at all raises an AnthropicError, which re-issues the turn.)
    const { provider, requests } = replaying(fixture("bad-tool-json.sse"));
    const events = await collect(provider.stream(request([user("x")]), new AbortController().signal));
    expect(requests).toHaveLength(1);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      call: { name: "grep", input: { pattern: "setDefault}}}}" } },
    });
  });

  test("HTTP errors become typed provider errors", async () => {
    const { provider } = replaying({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    });
    const events = await collect(provider.stream(request([user("x")]), new AbortController().signal));
    expect(events).toEqual([
      expect.objectContaining({ type: "turn_end", stop: "error", error: expect.objectContaining({ kind: "auth" }) }),
    ]);
  });

  test("error mapping, most specific first", () => {
    const headers = new Headers();
    expect(toProviderError(new Anthropic.RateLimitError(429, undefined, "slow down", headers)).kind).toBe("rate_limit");
    expect(toProviderError(new Anthropic.APIConnectionError({ message: "offline" })).kind).toBe("connection");
    expect(toProviderError(new Anthropic.InternalServerError(529, undefined, "overloaded", headers)).kind).toBe(
      "overloaded",
    );
    expect(toProviderError(new Anthropic.BadRequestError(400, undefined, "bad", headers)).kind).toBe("bad_request");
  });
});

describe("spending gate", () => {
  test("the API provider refuses to start unless spending is opted in", () => {
    const saved = process.env["CODECOACH_ALLOW_API_SPEND"];
    delete process.env["CODECOACH_ALLOW_API_SPEND"];
    try {
      expect(() => new AnthropicProvider({ client: { apiKey: "k" } })).toThrow(ApiSpendingDisabledError);
      process.env["CODECOACH_ALLOW_API_SPEND"] = "1";
      expect(() => new AnthropicProvider({ client: { apiKey: "k" } })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env["CODECOACH_ALLOW_API_SPEND"];
      else process.env["CODECOACH_ALLOW_API_SPEND"] = saved;
    }
  });
});
