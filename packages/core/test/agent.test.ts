import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AgentEvent, GuardHooks, StreamGuard } from "../src/index.js";
import {
  Agent,
  BudgetExceededError,
  BudgetMeter,
  MockProvider,
  ToolRegistry,
  Workspace,
  defineTool,
} from "../src/index.js";

function workspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-ws-"));
  writeFileSync(path.join(dir, "Robot.java"), "class Robot {}\n");
  return new Workspace(dir);
}

const echo = defineTool({
  name: "echo",
  description: "Echo",
  input: z.object({ value: z.string() }),
  readOnly: true,
  run: async ({ value }) => `echo:${value}`,
});

const l3Only = defineTool({
  name: "propose_diff",
  description: "L3",
  input: z.object({}),
  levels: ["L3"],
  readOnly: true,
  run: async () => "diff",
});

function agent(provider: MockProvider, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  return new Agent({
    provider,
    model: "claude-opus-5-5",
    system: [{ text: "You are a mentor.", cacheBreakpoint: true }],
    tools: new ToolRegistry([echo, l3Only]),
    level: "L0",
    toolContext: { workspace: workspace(), confirm: async () => true },
    ...extra,
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const shown = (events: AgentEvent[]) =>
  events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
const endOf = (events: AgentEvent[]) => events.at(-1) as Extract<AgentEvent, { type: "turn_end" }>;

/** Flags any turn containing "BAD"; releases everything else immediately. */
function badWordGuard(rewrite?: string): GuardHooks {
  return {
    start(): StreamGuard {
      return {
        push: (text) =>
          text.includes("BAD")
            ? { release: "", violations: [{ kind: "test", message: "bad word" }] }
            : { release: text },
        finish: () => ({ release: "" }),
      };
    },
    correctiveNote: (v) => `Fix: ${v.map((x) => x.message).join(", ")}`,
    ...(rewrite !== undefined ? { rewrite: async () => rewrite } : {}),
    fallbackText: "FALLBACK",
  };
}

describe("Agent", () => {
  test("commits a plain turn after the coaching context system message", async () => {
    const provider = new MockProvider([{ text: ["What have ", "you tried?"] }]);
    const a = agent(provider, { turnContext: () => "phase: describe" });
    const events = await collect(a.send({ text: "robot won't drive", escapeHatch: false }));
    expect(shown(events)).toBe("What have you tried?");
    expect(endOf(events).outcome).toBe("ok");
    expect(a.messages.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
    const req = provider.requests[0]!;
    expect(req.messages.at(-1)).toMatchObject({ role: "system", meta: { kind: "coaching_context" } });
  });

  test("only registers tools allowed at the level, sorted by name", async () => {
    const provider = new MockProvider([{ text: "ok" }]);
    await collect(agent(provider).send({ text: "hi", escapeHatch: false }));
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  test("returns every tool result in one message, invalid input as an error", async () => {
    const provider = new MockProvider([
      {
        text: "Let me look.",
        calls: [
          { id: "1", name: "echo", input: { value: "a" } },
          { id: "2", name: "echo", input: { value: 3 } },
          { id: "3", name: "propose_diff", input: {} },
        ],
      },
      { text: "Found it." },
    ]);
    const a = agent(provider);
    const events = await collect(a.send({ text: "look", escapeHatch: false }));
    const toolMsg = provider.requests[1]!.messages.at(-1)!;
    expect(toolMsg.role).toBe("user");
    const results = toolMsg.content.map((p) => (p.type === "tool_result" ? p.result : null));
    expect(results.map((r) => [r?.callId, r?.isError])).toEqual([
      ["1", false],
      ["2", true],
      ["3", true],
    ]);
    expect(results[2]!.content).toContain("Unknown tool");
    expect(shown(events)).toBe("Let me look.\n\nFound it.");
    expect(a.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("a violation discards the attempt and retries with a corrective note", async () => {
    const provider = new MockProvider([
      { text: ["Try this: ", "BAD code"] },
      { text: "What do you think the default command does?" },
    ]);
    const a = agent(provider, { guard: badWordGuard() });
    const events = await collect(a.send({ text: "help", escapeHatch: false }));
    expect(events.some((e) => e.type === "notice" && e.kind === "rewording")).toBe(true);
    expect(endOf(events)).toMatchObject({ outcome: "ok", violations: [{ kind: "test" }] });
    const retry = provider.requests[1]!.messages;
    expect(retry.at(-1)).toMatchObject({ role: "system", meta: { kind: "corrective_note" } });
    // The discarded attempt never reaches history; the note does (append-only).
    const committed = a.messages.map((m) => [m.role, m.meta?.kind]);
    expect(committed).toEqual([
      ["user", undefined],
      ["system", "corrective_note"],
      ["assistant", undefined],
    ]);
    expect(JSON.stringify(a.messages)).not.toContain("BAD");
  });

  test("two violations fall back to the rewrite, marked as rewritten", async () => {
    const provider = new MockProvider([{ text: "BAD" }, { text: "BAD again" }]);
    const a = agent(provider, { guard: badWordGuard("A hint: look at RobotContainer.") });
    const events = await collect(a.send({ text: "help", escapeHatch: false }));
    expect(endOf(events).outcome).toBe("rewritten");
    expect(shown(events)).toBe("A hint: look at RobotContainer.");
    expect(a.messages.at(-1)).toMatchObject({ role: "assistant", meta: { rewritten: true } });
  });

  test("a rewrite that still violates is replaced by the fallback text", async () => {
    const provider = new MockProvider([{ text: "BAD" }, { text: "BAD" }]);
    const events = await collect(
      agent(provider, { guard: badWordGuard("still BAD") }).send({ text: "x", escapeHatch: false }),
    );
    expect(shown(events)).toBe("FALLBACK");
  });

  test("refusals are not committed", async () => {
    const provider = new MockProvider([{ text: "", stop: "refusal" }]);
    const a = agent(provider);
    const events = await collect(a.send({ text: "x", escapeHatch: false }));
    expect(endOf(events).outcome).toBe("refused");
    expect(a.messages).toHaveLength(0);
  });

  test("never runs tools from a turn cut off at max_tokens", async () => {
    let ran = false;
    const spy = defineTool({
      name: "spy",
      description: "",
      input: z.object({}),
      readOnly: true,
      run: async () => ((ran = true), ""),
    });
    const provider = new MockProvider([{ calls: [{ id: "1", name: "spy", input: {} }], stop: "max_tokens" }]);
    const a = agent(provider, { tools: new ToolRegistry([spy]) });
    const events = await collect(a.send({ text: "x", escapeHatch: false }));
    expect(ran).toBe(false);
    expect(endOf(events).outcome).toBe("error");
  });

  test("stops tool use after the round limit and asks for a summary", async () => {
    const call = (id: string) => ({ calls: [{ id, name: "echo", input: { value: id } }] });
    const provider = new MockProvider([call("1"), call("2"), call("3"), { text: "Here is what I found." }]);
    const a = agent(provider, { maxToolRounds: 2 });
    const events = await collect(a.send({ text: "x", escapeHatch: false }));
    expect(endOf(events).outcome).toBe("ok");
    const notes = provider.requests[2]!.messages.filter((m) => m.meta?.kind === "tool_budget_note");
    expect(notes).toHaveLength(1);
    const third = provider.requests[3]!.messages.at(-1)!;
    expect(third.content[0]).toMatchObject({ type: "tool_result", result: { isError: true } });
  });

  test("stops before calling the provider once the monthly cap is reached", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
    const budget = new BudgetMeter({ ledgerDir: dir, monthlyCapUsd: 0.000001 });
    await budget.record("claude-opus-5-5", {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const provider = new MockProvider([{ text: "never" }]);
    const events = await collect(agent(provider, { budget }).send({ text: "x", escapeHatch: false }));
    expect(provider.requests).toHaveLength(0);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toMatchObject({ kind: "error" });
    expect((notice as { message: string }).message).toContain("budget");
    await expect(budget.check()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("records cost per turn", async () => {
    const provider = new MockProvider([{ text: "ok", usage: { inputTokens: 1_000_000 } }]);
    const budget = new BudgetMeter();
    const events = await collect(agent(provider, { budget }).send({ text: "x", escapeHatch: false }));
    expect(endOf(events).costUsd).toBeCloseTo(4);
  });

  test("abort ends the turn without committing", async () => {
    const provider = new MockProvider([{ text: ["a", "b", "c"] }]);
    const a = agent(provider);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const ev of a.send({ text: "x", escapeHatch: false }, controller.signal)) {
      events.push(ev);
      if (ev.type === "text") controller.abort();
    }
    expect(endOf(events).outcome).toBe("aborted");
    expect(a.messages).toHaveLength(0);
  });
});
