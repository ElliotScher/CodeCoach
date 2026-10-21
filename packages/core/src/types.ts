// Provider-neutral conversation types. Providers translate these to and from
// their own wire formats; everything above the provider layer only sees these.

export type GuardrailLevel = "L0" | "L1" | "L2" | "L3";
export const GUARDRAIL_LEVELS: readonly GuardrailLevel[] = ["L0", "L1", "L2", "L3"];

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

export type ContentPart =
  { type: "text"; text: string } | { type: "tool_call"; call: ToolCall } | { type: "tool_result"; result: ToolResult };

export type Role = "user" | "assistant" | "system";

export interface Message {
  role: Role;
  content: ContentPart[];
  /**
   * The provider's own assistant message, kept so that same-provider replay
   * sends it back byte-for-byte (thinking blocks, cache prefix). Providers
   * ignore raw content from other providers and use the neutral form.
   */
  raw?: { provider: string; data: unknown };
  /** Bookkeeping that is never sent to a provider. */
  meta?: MessageMeta;
}

export interface MessageMeta {
  /** A turn rewritten into hint form after failing the response checker twice. */
  rewritten?: boolean;
  /** The per-turn coaching context, as opposed to a corrective note. */
  kind?: "coaching_context" | "corrective_note" | "tool_budget_note";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function textOf(message: Message): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

export function systemText(text: string, kind?: MessageMeta["kind"]): Message {
  return kind
    ? { role: "system", content: [{ type: "text", text }], meta: { kind } }
    : { role: "system", content: [{ type: "text", text }] };
}
