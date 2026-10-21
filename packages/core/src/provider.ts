import type { Message, ToolCall, Usage } from "./types.js";

export type ProviderId = "anthropic" | "openai" | "google" | `sub:${string}` | "pool";

export interface ProviderCapabilities {
  promptCaching: boolean;
  /** Supports `system` messages after the first user message (keeps the cache prefix intact). */
  midConversationSystem: boolean;
  parallelTools: boolean;
  thinking: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}

/** A block of the top-level system prompt. */
export interface SystemBlock {
  text: string;
  /** Put a cache breakpoint after this block (providers without caching ignore it). */
  cacheBreakpoint?: boolean;
}

/** A tool as the model sees it: name, description and JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatRequest {
  model: string;
  system: SystemBlock[];
  /** Sorted by name; must be identical across a conversation to keep the cache prefix. */
  tools: ToolSpec[];
  messages: Message[];
  effort?: Effort;
  maxTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error";

export type ChatEvent =
  | { type: "text_delta"; text: string }
  /** Emitted once a tool call's input is complete. */
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "turn_end";
      stop: StopReason;
      usage: Usage;
      /** The provider's raw assistant message, stored for same-provider replay. */
      raw: unknown;
      /** Set when stop is "error" or "refusal". */
      error?: ProviderError;
    };

export type ProviderErrorKind =
  "auth" | "rate_limit" | "overloaded" | "connection" | "bad_request" | "refusal" | "aborted" | "other";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryable = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}
