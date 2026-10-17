import Anthropic from "@anthropic-ai/sdk";
import type { ClientOptions } from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { ProviderError } from "@codecoach/core";
import type { ChatEvent, ChatProvider, ChatRequest, Message, ModelInfo, StopReason, Usage } from "@codecoach/core";

import { assertApiSpendAllowed } from "./spend-gate.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
/** Cheap model for sub-tasks (rewriting a failed turn into a hint). */
export const ANTHROPIC_CHEAP_MODEL = "claude-haiku-5-5";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models that accept `fallbacks: "default"` (claude-api skill; Haiku 5.5 has no server-side fallback). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface AnthropicProviderOptions {
  /** Passed to the SDK client (apiKey, baseURL, fetch for tests, maxRetries…). */
  client?: ClientOptions;
  /** Server-side refusal fallbacks; on by default where the model supports them. */
  fallbacks?: boolean;
  /**
   * Opt in to API spending for this provider (otherwise CODECOACH_ALLOW_API_SPEND=1
   * must be set). Tests with a mocked `fetch` pass true; nothing is billed there.
   */
  allowApiSpend?: boolean;
}

/** Converts provider-neutral history to Anthropic messages. Same-provider assistant turns replay raw. */
export function toAnthropicMessages(messages: readonly Message[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content.map((p) => (p.type === "text" ? p.text : "")).join("") });
    } else if (m.role === "assistant") {
      const raw = m.raw?.provider === "anthropic" ? (m.raw.data as { content?: BetaContentBlock[] } | null) : null;
      if (raw?.content) {
        // Send the provider's own content back unchanged: thinking blocks and the cache prefix depend on it.
        out.push({ role: "assistant", content: raw.content as unknown as BetaContentBlockParam[] });
      } else {
        const content: BetaContentBlockParam[] = [];
        for (const p of m.content) {
          if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
          else if (p.type === "tool_call")
            content.push({
              type: "tool_use",
              id: p.call.id,
              name: p.call.name,
              input: p.call.input as Record<string, unknown>,
            });
        }
        out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "…" }] });
      }
    } else {
      const content: BetaContentBlockParam[] = m.content.map((p): BetaContentBlockParam => {
        if (p.type === "tool_result") {
          return {
            type: "tool_result",
            tool_use_id: p.result.callId,
            content: p.result.content,
            ...(p.result.isError ? { is_error: true } : {}),
          };
        }
        if (p.type === "text") return { type: "text", text: p.text };
        throw new Error("a user message can't contain a tool call");
      });
      out.push({ role: "user", content });
    }
  }
  // Cache breakpoint on the newest user turn (system messages after it can't carry one).
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "user" && Array.isArray(m.content) && m.content.length) {
      const last = m.content.at(-1)! as BetaContentBlockParam & { cache_control?: unknown };
      m.content = [
        ...m.content.slice(0, -1),
        { ...last, cache_control: { type: "ephemeral" } } as BetaContentBlockParam,
      ];
      break;
    }
  }
  return out;
}

export function buildRequest(req: ChatRequest, opts: { fallbacks: boolean }) {
  const system: BetaTextBlockParam[] = req.system.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cacheBreakpoint ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const tools: BetaTool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as BetaTool["input_schema"],
    // Stream tool inputs as generated; the registry validates them with Zod afterwards.
    eager_input_streaming: true,
  }));
  const useFallbacks = opts.fallbacks && FALLBACK_MODELS.has(req.model);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 64000,
    thinking: { type: "adaptive" as const },
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    system,
    ...(tools.length ? { tools, tool_choice: { type: "auto" as const } } : {}),
    messages: toAnthropicMessages(req.messages),
    ...(useFallbacks ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
  };
}

function toUsage(u: BetaMessage["usage"] | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function toStop(reason: BetaMessage["stop_reason"]): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** Maps the SDK's typed errors, most specific first. */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("aborted", "Cancelled.", false, err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(
      "auth",
      "Anthropic rejected the API key. Check the key in CodeCoach's settings (or ANTHROPIC_API_KEY).",
      false,
      err,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError(
      "rate_limit",
      "Anthropic is rate-limiting this key. Wait a minute and try again.",
      true,
      err,
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(
      "connection",
      "Couldn't reach Anthropic. Check the internet connection (school networks sometimes block it).",
      true,
      err,
    );
  }
  if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && err.status === 529)) {
    return new ProviderError("overloaded", "Anthropic is overloaded right now. Try again in a moment.", true, err);
  }
  if (err instanceof Anthropic.BadRequestError)
    return new ProviderError("bad_request", `Anthropic rejected the request: ${err.message}`, false, err);
  if (err instanceof Anthropic.APIError)
    return new ProviderError("other", `Anthropic error ${err.status ?? ""}: ${err.message}`, false, err);
  return new ProviderError("other", err instanceof Error ? err.message : String(err), false, err);
}

export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly capabilities = { promptCaching: true, midConversationSystem: true, parallelTools: true, thinking: true };
  readonly client: Anthropic;
  private readonly fallbacks: boolean;

  constructor(opts: AnthropicProviderOptions = {}) {
    assertApiSpendAllowed("The Anthropic API provider", opts.allowApiSpend);
    this.client = new Anthropic(opts.client);
    this.fallbacks = opts.fallbacks ?? true;
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    for await (const m of this.client.models.list()) models.push({ id: m.id, displayName: m.display_name });
    return models;
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const params = buildRequest(req, { fallbacks: this.fallbacks });
    for (let attempt = 0; ; attempt++) {
      let streamed = false;
      try {
        const stream = this.client.beta.messages.stream(params, { signal });
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            streamed = true;
            yield { type: "text_delta", text: ev.delta.text };
          }
        }
        const message = await stream.finalMessage();
        const stop = toStop(message.stop_reason);
        if (stop !== "refusal") {
          for (const block of message.content) {
            if (block.type === "tool_use")
              yield { type: "tool_call", call: { id: block.id, name: block.name, input: block.input } };
          }
        }
        yield {
          type: "turn_end",
          stop,
          usage: toUsage(message.usage),
          raw: { id: message.id, model: message.model, content: message.content },
          ...(stop === "refusal"
            ? {
                error: new ProviderError(
                  "refusal",
                  `Declined${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}.`,
                ),
              }
            : {}),
        };
        return;
      } catch (err) {
        // With eager input streaming the SDK throws a plain AnthropicError (not an
        // APIError) for tool input it can't parse at all. Re-issue that turn, at
        // most twice, if nothing was shown yet; typed API errors are never retried here.
        const isJsonError = err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError);
        if (isJsonError && !signal.aborted && !streamed && attempt < 2) continue;
        const e = signal.aborted ? new ProviderError("aborted", "Cancelled.") : toProviderError(err);
        yield { type: "turn_end", stop: "error", usage: toUsage(undefined), raw: null, error: e };
        return;
      }
    }
  }
}
