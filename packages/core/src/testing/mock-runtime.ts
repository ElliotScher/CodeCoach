import type { ToolSpec } from "../provider.js";
import type { ConversationRuntime, RuntimeEvent, UsageLimitInfo } from "../runtime.js";
import type { ToolCall, ToolResult, Usage } from "../types.js";

/** One scripted runtime turn: text chunks, tool calls (run through the host), and how it ends. */
export interface MockRuntimeTurn {
  steps: ({ text: string } | { call: ToolCall } | { limit: UsageLimitInfo })[];
  usage?: Partial<Usage>;
}

/** A ConversationRuntime that replays scripted turns, for tests. */
export class MockRuntime implements ConversationRuntime {
  readonly id = "mock-runtime";
  readonly sent: string[] = [];
  system: string | null = null;
  tools: ToolSpec[] = [];
  interrupts = 0;
  closed = false;
  private callTool: ((call: ToolCall) => Promise<ToolResult>) | null = null;
  private interrupted = false;

  constructor(private readonly turns: MockRuntimeTurn[]) {}

  async start(opts: {
    system: string;
    tools: ToolSpec[];
    callTool(call: ToolCall): Promise<ToolResult>;
  }): Promise<void> {
    this.system = opts.system;
    this.tools = opts.tools;
    this.callTool = opts.callTool;
  }

  async *turn(text: string): AsyncIterable<RuntimeEvent> {
    this.sent.push(text);
    this.interrupted = false;
    const turn = this.turns.shift();
    if (!turn) throw new Error("MockRuntime: no scripted turn left");
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...turn.usage };
    for (const step of turn.steps) {
      if (this.interrupted) break;
      if ("text" in step) yield { type: "text_delta", text: step.text };
      else if ("limit" in step) yield { type: "limit", info: step.limit };
      else {
        yield { type: "tool_start", call: step.call };
        const result = await this.callTool!(step.call);
        yield { type: "tool_end", callId: step.call.id, result };
      }
    }
    yield { type: "turn_end", stop: this.interrupted ? "interrupted" : "end_turn", usage };
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
    this.interrupted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
