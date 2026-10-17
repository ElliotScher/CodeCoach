// Live smoke test against the real API. Costs a few cents, so it only runs
// with both ANTHROPIC_API_KEY and CODECOACH_LIVE=1 set:
//   CODECOACH_LIVE=1 pnpm vitest run packages/providers/test/anthropic.live.test.ts
import { describe, expect, test } from "vitest";

import type { ChatEvent, ChatRequest, Message } from "@codecoach/core";

import { AnthropicProvider } from "../src/index.js";

const live = Boolean(process.env["ANTHROPIC_API_KEY"] && process.env["CODECOACH_LIVE"] === "1");

// Comfortably above the 512-token minimum cacheable prefix.
const SYSTEM = Array.from(
  { length: 40 },
  (_, i) =>
    `Mentor rule ${i + 1}: ask the student what they have tried, get their hypothesis before explaining, and keep hints small.`,
).join("\n");

async function turn(provider: AnthropicProvider, messages: Message[]) {
  const req: ChatRequest = {
    model: "claude-opus-5-5",
    effort: "low",
    maxTokens: 2000,
    system: [{ text: SYSTEM, cacheBreakpoint: true }],
    tools: [],
    messages,
  };
  const events: ChatEvent[] = [];
  for await (const e of provider.stream(req, new AbortController().signal)) events.push(e);
  return events.at(-1) as Extract<ChatEvent, { type: "turn_end" }>;
}

describe.skipIf(!live)("Anthropic live", () => {
  test("turn 2 reads the cache written by turn 1", async () => {
    const provider = new AnthropicProvider();
    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "My robot won't drive in teleop." }] }];
    const first = await turn(provider, history);
    expect(first.stop).toBe("end_turn");
    history.push({ role: "assistant", content: [], raw: { provider: "anthropic", data: first.raw } });
    history.push({ role: "user", content: [{ type: "text", text: "I already checked the controller." }] });
    const second = await turn(provider, history);
    expect(second.stop).toBe("end_turn");
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  }, 120_000);
});
