import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { RuntimeAgent, ToolRegistry, Workspace, defineTool } from "@codecoach/core";
import type { AgentEvent, ChatEvent, GuardHooks, RuntimeEvent } from "@codecoach/core";

import {
  ClaudeCodeProvider,
  ClaudeCodeRuntime,
  SubscriptionAuthError,
  assertSubscriptionAuth,
  checkInit,
  claudeCodeArgs,
  claudeCodeJson,
  parseStreamLine,
  subscriptionEnv,
} from "../src/index.js";
import type { InitInfo } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude-code/", import.meta.url));
const FAKE = [process.execPath, path.join(FIXTURES, "fake-claude.mjs")];
const lines = (name: string) =>
  readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
const events = (name: string): RuntimeEvent[] =>
  lines(name).flatMap((l) => {
    const p = parseStreamLine(l);
    return p.kind === "events" ? p.events : [];
  });
const init = (name: string): InitInfo => {
  for (const l of lines(name)) {
    const p = parseStreamLine(l);
    if (p.kind === "init") return p.init;
  }
  throw new Error("no init");
};

describe("stream-json parsing (recorded from Claude Code 2.1.301)", () => {
  test("a tool turn: tool call without the MCP prefix, its result, streamed text, usage and limits", () => {
    const ev = events("tool-turn");
    expect(ev.find((e) => e.type === "tool_start")).toEqual({
      type: "tool_start",
      call: { id: expect.stringMatching(/^toolu_/), name: "read_file", input: { path: "notes.txt" } },
    });
    expect(ev.find((e) => e.type === "tool_end")).toMatchObject({
      result: { isError: false, content: expect.stringContaining("Drivetrain needs a default command.") },
    });
    const text = ev
      .filter((e): e is Extract<RuntimeEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toContain("Drivetrain needs a default command.");
    expect(ev.find((e) => e.type === "limit")).toMatchObject({
      info: { status: "allowed", window: expect.any(String) },
    });
    const end = ev.at(-1) as Extract<RuntimeEvent, { type: "turn_end" }>;
    expect(end).toMatchObject({ type: "turn_end", stop: "end_turn" });
    expect(end.usage.outputTokens).toBeGreaterThan(0);
    expect(end.apiEquivalentUsd).toBeGreaterThan(0);
  });

  test("init shows only CodeCoach's tools, the server connected, and no API key", () => {
    const i = init("tool-turn");
    expect(i).toMatchObject({ tools: ["mcp__codecoach__read_file"], apiKeySource: "none" });
    expect(checkInit(i, ["read_file"])).toBeNull();
  });

  test("refuses API-key auth, Claude Code's own tools, or a disconnected tool server", () => {
    const i = init("tool-turn");
    expect(checkInit({ ...i, apiKeySource: "ANTHROPIC_API_KEY" }, ["read_file"])).toMatch(/API key/);
    expect(checkInit({ ...i, tools: [...i.tools, "Bash"] }, ["read_file"])).toMatch(/own tools are enabled \(Bash\)/);
    expect(checkInit({ ...i, mcpServers: [{ name: "codecoach", status: "failed" }] }, ["read_file"])).toMatch(
      /didn't connect/,
    );
    expect(checkInit({ ...i, tools: [] }, ["read_file"])).toMatch(/didn't load/);
  });

  test("interrupted and failed results", () => {
    const interrupted = parseStreamLine(
      JSON.stringify({ type: "result", subtype: "error_during_execution", terminal_reason: "aborted_streaming" }),
    );
    expect(interrupted).toMatchObject({ kind: "events", events: [{ type: "turn_end", stop: "interrupted" }] });
    const limited = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        api_error_status: 429,
        result: "Rate limited",
      }),
    );
    expect(limited).toMatchObject({
      events: [{ stop: "error", error: { kind: "rate_limit", message: "Rate limited" } }],
    });
  });
});

describe("process setup", () => {
  test("built-in tools off, CodeCoach's MCP tools only, permissions denied, system prompt replaced", () => {
    const args = claudeCodeArgs({ system: "SYS", mcpConfig: { mcpServers: {} }, model: "opus", effort: "medium" });
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--tools")).toBe("");
    expect(after("--allowedTools")).toBe("mcp__codecoach");
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(after("--permission-prompts")).toBe("none");
    expect(after("--system-prompt")).toBe("SYS");
    expect(after("--effort")).toBe("medium");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--bare"); // --bare only accepts API keys
    expect(args).not.toContain("--append-system-prompt");
  });

  test("the child environment never carries an API key", () => {
    const env = subscriptionEnv({
      ANTHROPIC_API_KEY: "sk",
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "/bin",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("auth must be a claude.ai subscription", () => {
    expect(() => assertSubscriptionAuth(null)).toThrow(SubscriptionAuthError);
    expect(() => assertSubscriptionAuth({ loggedIn: false })).toThrow(/isn't signed in/);
    expect(() => assertSubscriptionAuth({ loggedIn: true, authMethod: "api_key" })).toThrow(
      /not a claude.ai subscription/,
    );
    expect(assertSubscriptionAuth({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" })).toMatchObject({
      subscriptionType: "pro",
    });
  });
});

const readFile = defineTool({
  name: "read_file",
  description: "Read",
  input: z.object({ path: z.string() }),
  readOnly: true,
  run: async () => "x",
});

function runtimeAgent(script: string, guard?: GuardHooks) {
  process.env["FAKE_CLAUDE_SCRIPT"] = script;
  const runtime = new ClaudeCodeRuntime({ command: FAKE, skipAuthCheck: true });
  const agent = new RuntimeAgent({
    runtime,
    system: "sys",
    tools: new ToolRegistry([readFile]),
    level: "L0",
    toolContext: { workspace: new Workspace(mkdtempSync(path.join(os.tmpdir(), "cc-"))), confirm: async () => false },
    ...(guard ? { guard } : {}),
  });
  return agent;
}

async function run(gen: AsyncGenerator<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

let open: RuntimeAgent | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env["FAKE_CLAUDE_SCRIPT"];
  delete process.env["FAKE_CLAUDE_INIT_TOOLS"];
});

describe("ClaudeCodeRuntime process (fake claude replaying recordings)", () => {
  test("two turns in one process, with tool events", async () => {
    open = runtimeAgent("tool-turn,text-turn");
    const first = await run(open.send({ text: "read it", escapeHatch: false }));
    expect(first.some((e) => e.type === "tool_end" && e.call.name === "read_file")).toBe(true);
    expect(first.at(-1)).toMatchObject({ type: "turn_end", outcome: "ok" });
    const second = await run(open.send({ text: "say ok", escapeHatch: false }));
    expect(
      second
        .filter((e) => e.type === "text")
        .map((e) => (e as { text: string }).text)
        .join("")
        .toLowerCase(),
    ).toContain("ok");
  });

  test("a blocked reply is interrupted, then the rephrase turn is shown", async () => {
    const blockFirst: GuardHooks = (() => {
      let n = 0;
      return {
        start: () => {
          const block = n++ === 0;
          return {
            push: (t) => (block ? { release: "", violations: [{ kind: "test", message: "blocked" }] } : { release: t }),
            finish: () => ({ release: "" }),
          };
        },
        correctiveNote: () => "rephrase",
        fallbackText: "FALLBACK",
      };
    })();
    open = runtimeAgent("tool-turn,text-turn", blockFirst);
    const ev = await run(open.send({ text: "x", escapeHatch: false }));
    expect(ev.some((e) => e.type === "notice" && e.kind === "rewording")).toBe(true);
    expect(ev.at(-1)).toMatchObject({ outcome: "ok", violations: [{ kind: "test" }] });
    // Nothing from the blocked turn's text was shown; the rephrase turn's was.
    const shown = ev
      .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(shown).not.toContain("Drivetrain");
    expect(shown.toLowerCase()).toContain("ok");
  });

  test("refuses to run when Claude Code reports its own tools", async () => {
    process.env["FAKE_CLAUDE_INIT_TOOLS"] = "Bash,mcp__codecoach__read_file";
    open = runtimeAgent("text-turn");
    const ev = await run(open.send({ text: "x", escapeHatch: false }));
    expect(ev.find((e) => e.type === "notice")).toMatchObject({
      message: expect.stringMatching(/own tools are enabled/),
    });
    expect(ev.at(-1)).toMatchObject({ outcome: "error" });
  });
});

describe("one-shot helpers", () => {
  test("ClaudeCodeProvider streams a tool-less reply", async () => {
    process.env["FAKE_CLAUDE_SCRIPT"] = "text-turn";
    const p = new ClaudeCodeProvider({ command: FAKE, skipAuthCheck: true });
    // The one-shot fake reads stdin as a single user message in stream-json form.
    const evs: ChatEvent[] = [];
    for await (const e of p.stream(
      { model: "haiku", system: [{ text: "s" }], tools: [], messages: [] },
      new AbortController().signal,
    ))
      evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "turn_end" });
    await expect(async () => {
      for await (const _ of p.stream(
        { model: "haiku", system: [], tools: [{ name: "t", description: "", inputSchema: {} }], messages: [] },
        new AbortController().signal,
      ))
        void _;
    }).rejects.toThrow(/tool-less/);
  });

  test("claudeCodeJson returns structured output", async () => {
    const r = await claudeCodeJson({
      system: "s",
      prompt: "grade this",
      schema: { type: "object" },
      command: FAKE,
      skipAuthCheck: true,
    });
    expect(r).toMatchObject({ output: { echoed: "grade this" }, usage: { inputTokens: 5 } });
    expect(r.error).toBeUndefined();
  });
});
