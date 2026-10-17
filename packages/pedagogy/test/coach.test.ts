import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { MockProvider, Workspace } from "@codecoach/core";
import type { AgentEvent, MockTurn } from "@codecoach/core";

import { Coach } from "../src/index.js";

function coach(turns: MockTurn[], rewriterTurns: MockTurn[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coach-"));
  writeFileSync(
    path.join(dir, "RobotContainer.java"),
    "public class RobotContainer {\n  private final Drive m_drive = new Drive();\n}\n",
  );
  const provider = new MockProvider(turns);
  const rewriter = new MockProvider(rewriterTurns);
  const c = new Coach({
    provider,
    model: "claude-opus-5-5",
    level: "L0",
    workspace: new Workspace(dir),
    tools: [],
    projectSummary: "Language: java",
    profile: { language: "en", readingLevel: "standard" },
    confirm: async () => false,
    rewriter: { provider: rewriter, model: "claude-haiku-5-5" },
  });
  return { c, provider, rewriter };
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

const FIX =
  "```java\nm_drive.setDefaultCommand(new RunCommand(() -> m_drive.drive(), m_drive));\nm_drive.enable();\nm_drive.go();\n```\n";

describe("Coach", () => {
  test("the model drives the state machine through update_coaching_state", async () => {
    const { c, provider } = coach([
      { calls: [{ id: "1", name: "update_coaching_state", input: { phase: "describe" } }] },
      { text: "What does the robot do when you push the stick?" },
      { calls: [{ id: "2", name: "update_coaching_state", input: { phase: "observe" } }] },
      { text: "Before we look, what's your guess?" },
    ]);
    await run(c.send("robot won't drive"));
    expect(c.state.state.phase).toBe("describe");
    const r = await run(c.send("it just sits there"));
    // The gate refused observe without a hypothesis; the model got the reason as a tool error.
    const toolResult = provider.requests[3]!.messages.at(-1)!.content[0];
    expect(toolResult).toMatchObject({
      type: "tool_result",
      result: { isError: true, content: expect.stringMatching(/hypothesis first|Can't go/) },
    });
    expect(c.state.state.phase).toBe("describe");
    expect(r.end.outcome).toBe("ok");
  });

  test("a fix at L0 is held back, retried with a note, then rewritten", async () => {
    const { c, provider, rewriter } = coach(
      [{ text: `Add this to RobotContainer:\n${FIX}` }, { text: `Sorry, here:\n${FIX}` }],
      [{ text: "Look at the RobotContainer constructor: which subsystems get a default command there?" }],
    );
    const r = await run(c.send("tell me the fix"));
    expect(r.text).not.toContain("setDefaultCommand(new RunCommand");
    expect(r.end.outcome).toBe("rewritten");
    expect(r.text).toContain("which subsystems get a default command");
    expect(provider.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/not shown to the student/),
    });
    expect(rewriter.requests[0]!.model).toBe("claude-haiku-5-5");
    expect(c.agent.messages.at(-1)!.meta?.rewritten).toBe(true);
  });

  test("the per-turn coaching context follows the student's message", async () => {
    const { c, provider } = coach([{ text: "What have you tried?" }]);
    await run(c.send("help", { escapeHatch: true }));
    const msgs = provider.requests[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "system"]);
    expect(msgs[1]!.content[0]).toMatchObject({ text: expect.stringMatching(/asked you to tell them/) });
  });

  test("records a prompt hash and tool list including update_coaching_state", () => {
    const { c } = coach([]);
    expect(c.prompt.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(c.prompt.versions).toBe("persona@1 rules@1 levels/L0@1");
  });
});
