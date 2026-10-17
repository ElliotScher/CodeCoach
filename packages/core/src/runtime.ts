import type { ProviderError, StopReason, ToolSpec } from "./provider.js";
import type { ToolCall, ToolResult, Usage } from "./types.js";

/**
 * A vendor runtime that runs its own tool loop and owns the conversation
 * (Claude Code headless; later Codex app-server, Gemini CLI). CodeCoach gives
 * it a fixed system prompt and its tools (served back to the runtime over
 * MCP), sends one message per turn and watches the events.
 */
export interface ConversationRuntime {
  /** e.g. "claude-code". Recorded in sessions and eval results. */
  readonly id: string;
  /** Starts the runtime. Tool calls the runtime makes come back through `callTool`. */
  start(opts: { system: string; tools: ToolSpec[]; callTool(call: ToolCall): Promise<ToolResult> }): Promise<void>;
  /** Sends one message and streams the runtime's turn until it ends. */
  turn(text: string, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  /** Stops the turn in progress (its partial reply stays in the runtime's history). */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface UsageLimitInfo {
  /** "allowed", "allowed_warning" or "rejected" (Claude Code's rate_limit_event). */
  status: string;
  /** 0–1 utilization of the window that's closest to its limit, when reported. */
  utilization?: number;
  /** When the limiting window resets (ms since epoch). */
  resetsAt?: number;
  window?: string;
}

export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  /** Tool names are CodeCoach's own (the runtime's MCP prefix removed). */
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; callId: string; result: ToolResult }
  | { type: "limit"; info: UsageLimitInfo }
  | {
      type: "turn_end";
      stop: StopReason | "interrupted";
      usage: Usage;
      /** The runtime's API-equivalent cost estimate. Not a bill on a subscription. */
      apiEquivalentUsd?: number;
      error?: ProviderError;
    };
