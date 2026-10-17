import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AgentEvent, GuardHooks, UsageLimitInfo } from "../src/index.js";
import { MockRuntime, RuntimeAgent, ToolRegistry, Workspace, defineTool } from "../src/index.js";
import type { MockRuntimeTurn } from "../src/testing/mock-runtime.js";

const echo = defineTool({
  name: "echo",
  description: "Echo",
  input: z.object({ value: z.string() }),
  readOnly: true,
  run: async ({ value }) => `echo:${value}`,
});

const badWordGuard: GuardHooks = {
  start: () => ({
    push: (text) =>
      text.includes("BAD") ? { release: "", violations: [{ kind: "test", message: "bad word" }] } : { release: text },
    finish: () => ({ release: "" }),
  }),
  correctiveNote: (v) => `Fix: ${v.map((x) => x.message).join(", ")}`,
  fallbackText: "FALLBACK",
};

function agent(
  turns: MockRuntimeTurn[],
  extra: { guard?: GuardHooks; onLimit?: (i: UsageLimitInfo) => void; maxToolCalls?: number } = {},
) {
  const runtime = new MockRuntime(turns);
  const a = new RuntimeAgent({
    runtime,
    system: "You are a mentor.",
    tools: new ToolRegistry([echo]),
    level: "L0",
    toolContext: { workspace: new Workspace(mkdtempSync(path.join(os.tmpdir(), "rt-"))), confirm: async () => false },
    turnContext: () => "phase: describe",
    ...extra,
  });
  return { a, runtime };
}

async function run(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  const text = events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  return { events, text, end: events.at(-1) as Extract<AgentEvent, { type: "turn_end" }> };
}

describe("RuntimeAgent", () => {
  test("starts the runtime once with the system prompt and level's tools, and marks the turn context", async () => {
    const { a, runtime } = agent([{ steps: [{ text: "What have you tried?" }] }, { steps: [{ text: "OK." }] }]);
    const r = await run(a.send({ text: "robot won't drive", escapeHatch: false }));
    await run(a.send({ text: "nothing", escapeHatch: false }));
    expect(r.text).toBe("What have you tried?");
    expect(runtime.system).toBe("You are a mentor.");
    expect(runtime.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(runtime.sent[0]).toBe(
      "<codecoach_turn_context>\nphase: describe\n</codecoach_turn_context>\n\nStudent:\nrobot won't drive",
    );
    expect(a.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(r.end).toMatchObject({ outcome: "ok", costUsd: 0 });
  });

  test("tool calls run through CodeCoach's registry and show as tool events", async () => {
    const { a } = agent([
      { steps: [{ call: { id: "t1", name: "echo", input: { value: "x" } } }, { text: "Found it." }] },
    ]);
    const r = await run(a.send({ text: "look", escapeHatch: false }));
    const end = r.events.find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ call: { id: "t1", name: "echo" }, result: { isError: false, content: "echo:x" } });
  });

  test("a blocked reply is interrupted and replaced by a rephrase turn", async () => {
    const { a, runtime } = agent(
      [
        { steps: [{ text: "Here: " }, { text: "BAD code" }, { text: "never streamed" }] },
        { steps: [{ text: "What do you think the default command does?" }] },
      ],
      { guard: badWordGuard },
    );
    const r = await run(a.send({ text: "help", escapeHatch: false }));
    expect(runtime.interrupts).toBe(1);
    expect(runtime.sent[1]).toMatch(/^\(Message from CodeCoach, not the student\.[^\n]*\)\nFix: bad word/);
    expect(r.text).toBe("Here: What do you think the default command does?");
    expect(r.end).toMatchObject({ outcome: "ok", violations: [{ kind: "test" }] });
    expect(JSON.stringify(a.messages)).not.toContain("BAD");
  });

  test("twice blocked falls back", async () => {
    const { a } = agent([{ steps: [{ text: "BAD" }] }, { steps: [{ text: "BAD again" }] }], { guard: badWordGuard });
    const r = await run(a.send({ text: "help", escapeHatch: false }));
    expect(r.text).toBe("FALLBACK");
    expect(r.end.outcome).toBe("rewritten");
  });

  test("usage-limit reports reach the caller, and a rejection ends the turn with a message", async () => {
    const limits: UsageLimitInfo[] = [];
    const { a } = agent(
      [
        { steps: [{ limit: { status: "allowed", utilization: 0.4 } }, { text: "ok" }] },
        { steps: [{ limit: { status: "rejected", resetsAt: 0 } }] },
      ],
      { onLimit: (i) => limits.push(i) },
    );
    expect((await run(a.send({ text: "x", escapeHatch: false }))).end.outcome).toBe("ok");
    const r = await run(a.send({ text: "y", escapeHatch: false }));
    expect(r.end.outcome).toBe("error");
    expect(r.events.find((e) => e.type === "notice")).toMatchObject({ message: expect.stringMatching(/usage limit/) });
    expect(limits.map((l) => l.status)).toEqual(["allowed", "rejected"]);
  });

  test("too many tool calls interrupt the turn", async () => {
    const call = (id: string) => ({ call: { id, name: "echo", input: { value: id } } });
    const { a, runtime } = agent([{ steps: [call("1"), call("2"), call("3"), { text: "late" }] }], { maxToolCalls: 2 });
    const r = await run(a.send({ text: "x", escapeHatch: false }));
    expect(runtime.interrupts).toBe(1);
    expect(r.end.outcome).toBe("error");
  });

  test("closes the runtime", async () => {
    const { a, runtime } = agent([]);
    await a.close();
    expect(runtime.closed).toBe(true);
  });
});
