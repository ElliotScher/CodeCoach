import type { ChatEvent, ChatProvider, ChatRequest, StopReason } from "../provider.js";
import type { ToolCall, Usage } from "../types.js";

/** One scripted assistant response. */
export interface MockTurn {
  text?: string | string[];
  calls?: ToolCall[];
  stop?: StopReason;
  usage?: Partial<Usage>;
  error?: Error;
}

/**
 * A provider that replays scripted turns, for tests and offline demos.
 * Every request is recorded in `requests` for assertions.
 */
export class MockProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly capabilities = { promptCaching: true, midConversationSystem: true, parallelTools: true, thinking: false };
  readonly requests: ChatRequest[] = [];
  private readonly turns: MockTurn[];

  constructor(turns: MockTurn[]) {
    this.turns = [...turns];
  }

  get remaining(): number {
    return this.turns.length;
  }

  async listModels() {
    return [{ id: "mock", displayName: "Mock" }];
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error("MockProvider: no scripted turn left");
    if (turn.error) throw turn.error;
    const chunks = typeof turn.text === "string" ? [turn.text] : (turn.text ?? []);
    for (const text of chunks) {
      if (signal.aborted) return;
      yield { type: "text_delta", text };
    }
    for (const call of turn.calls ?? []) yield { type: "tool_call", call };
    yield {
      type: "turn_end",
      stop: turn.stop ?? (turn.calls?.length ? "tool_use" : "end_turn"),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...turn.usage },
      raw: { mock: true, text: chunks.join(""), calls: turn.calls ?? [] },
    };
  }
}
