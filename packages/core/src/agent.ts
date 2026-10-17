import type { BudgetMeter } from "./budget.js";
import type { GuardHooks, StreamGuard, Violation } from "./guard.js";
import { PASSTHROUGH_GUARD } from "./guard.js";
import type { ChatProvider, ChatRequest, Effort, ProviderError, StopReason, SystemBlock } from "./provider.js";
import type { Session } from "./session-store.js";
import type { ToolContext, ToolRegistry } from "./tools/registry.js";
import type { GuardrailLevel, Message, ToolCall, ToolResult, Usage } from "./types.js";
import { ZERO_USAGE, addUsage, systemText, userText } from "./types.js";

export const DEFAULT_MAX_TOOL_ROUNDS = 12;

export interface TurnInput {
  text: string;
  /** The student asked to be told ("just tell me"). */
  escapeHatch: boolean;
}

export type TurnOutcome = "ok" | "rewritten" | "refused" | "error" | "aborted";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  | { type: "notice"; kind: "rewording" | "refusal" | "error" | "tool_limit"; message: string }
  | { type: "turn_end"; outcome: TurnOutcome; usage: Usage; costUsd: number; violations: Violation[] };

export interface AgentOptions {
  provider: ChatProvider;
  model: string;
  effort?: Effort;
  maxTokens?: number;
  /** Top-level system prompt. Fixed for the session so the cache prefix survives. */
  system: SystemBlock[];
  tools: ToolRegistry;
  level: GuardrailLevel;
  toolContext: Omit<ToolContext, "signal">;
  /** Previously committed history (resumed sessions). */
  history?: Message[];
  maxToolRounds?: number;
  budget?: BudgetMeter;
  session?: Session;
  /** Per-turn coaching context, sent as a system message after the student's message. */
  turnContext?: (input: TurnInput) => string | null;
  guard?: GuardHooks;
}

/** What one attempt at a turn produced. */
interface Attempt {
  status: "ok" | "violation" | "refused" | "error" | "aborted";
  messages: Message[];
  shownText: string;
  draftText: string;
  violations: Violation[];
  error?: ProviderError | Error;
}

/**
 * The coach's turn loop: stream the reply through the response guard, run
 * tool rounds, and commit the turn to history only once it passes. History is
 * append-only; a discarded attempt never reaches it.
 */
export class Agent {
  private readonly history: Message[];
  private opts: AgentOptions;
  private readonly guard: GuardHooks;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.history = [...(opts.history ?? [])];
    this.guard = opts.guard ?? PASSTHROUGH_GUARD;
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  /** Starts logging to `session` (for sessions created after the agent, e.g. to record its prompt hash). */
  attachSession(session: Session): void {
    this.opts = { ...this.opts, session };
  }

  async *send(input: TurnInput, signal: AbortSignal = new AbortController().signal): AsyncGenerator<AgentEvent> {
    let usage: Usage = ZERO_USAGE;
    let cost = 0;
    const allViolations: Violation[] = [];
    const end = (outcome: TurnOutcome): AgentEvent => ({
      type: "turn_end",
      outcome,
      usage,
      costUsd: cost,
      violations: allViolations,
    });

    // Steps 1-2: the student's message, then the per-turn coaching context after it.
    const pending: Message[] = [userText(input.text)];
    const context = this.opts.turnContext?.(input);
    if (context) pending.push(systemText(context, "coaching_context"));

    const track = async (u: Usage) => {
      usage = addUsage(usage, u);
      if (this.opts.budget) cost += await this.opts.budget.record(this.opts.model, u);
    };

    for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
      const attempt = yield* this.attempt(pending, signal, track);
      if (attempt.status === "ok") {
        await this.commit([...pending, ...attempt.messages]);
        yield end("ok");
        return;
      }
      if (attempt.status === "aborted") {
        yield end("aborted");
        return;
      }
      if (attempt.status === "refused") {
        yield {
          type: "notice",
          kind: "refusal",
          message: "I can't help with that one. Let's get back to the robot: what is it doing right now?",
        };
        await this.opts.session?.append({ type: "event", name: "refusal" });
        yield end("refused");
        return;
      }
      if (attempt.status === "error") {
        yield { type: "notice", kind: "error", message: attempt.error?.message ?? "Something went wrong." };
        yield end("error");
        return;
      }
      // Violation: discard the attempt, tell the student, retry with a corrective note.
      allViolations.push(...attempt.violations);
      await this.opts.session?.append({ type: "event", name: "guard_violation", data: attempt.violations });
      yield { type: "notice", kind: "rewording", message: "Let me put that as a hint instead…" };
      if (attemptNo === 0) {
        pending.push(systemText(this.guard.correctiveNote(attempt.violations), "corrective_note"));
        continue;
      }
      // Two failures: rewrite the draft into hint form with a cheap model.
      const rewritten = await this.rewrite(attempt, signal);
      yield { type: "text", text: rewritten };
      await this.commit([
        ...pending,
        { role: "assistant", content: [{ type: "text", text: rewritten }], meta: { rewritten: true } },
      ]);
      yield end("rewritten");
      return;
    }
  }

  private async rewrite(attempt: Attempt, signal: AbortSignal): Promise<string> {
    const candidate = await this.guard.rewrite?.(attempt.draftText, attempt.violations, signal).catch(() => null);
    if (candidate) {
      const g = this.guard.start();
      const a = g.push(candidate);
      const b = g.finish();
      if (!a.violations && !b.violations) return candidate;
    }
    return this.guard.fallbackText;
  }

  /** One attempt at a turn: as many tool rounds as the model needs, streamed through the guard. */
  private async *attempt(
    pending: readonly Message[],
    outerSignal: AbortSignal,
    track: (u: Usage) => Promise<void>,
  ): AsyncGenerator<AgentEvent, Attempt> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outerSignal.addEventListener("abort", onAbort, { once: true });
    const signal = controller.signal;
    const guard: StreamGuard = this.guard.start();
    const messages: Message[] = [];
    let shownText = "";
    let draftText = "";
    const maxRounds = this.opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const result = (status: Attempt["status"], extra: Partial<Attempt> = {}): Attempt => ({
      status,
      messages,
      shownText,
      draftText,
      violations: [],
      ...extra,
    });
    // Stop the provider stream; the attempt is discarded.
    const violation = (c: AbortController, violations: Violation[]): Attempt => {
      c.abort();
      return result("violation", { violations });
    };

    try {
      for (let round = 0; ; round++) {
        if (outerSignal.aborted) return result("aborted");
        try {
          await this.opts.budget?.check();
        } catch (err) {
          return result("error", { error: err as Error });
        }
        const req: ChatRequest = {
          model: this.opts.model,
          system: this.opts.system,
          tools: this.opts.tools.specs(this.opts.level),
          messages: [...this.history, ...pending, ...messages],
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
          ...(this.opts.maxTokens ? { maxTokens: this.opts.maxTokens } : {}),
        };

        const calls: ToolCall[] = [];
        const text: string[] = [];
        let stop: StopReason = "error";
        let raw: unknown = null;
        let error: ProviderError | undefined;
        if (round > 0 && draftText) {
          // Keep text from separate assistant messages apart.
          const v = guard.push("\n\n");
          if (v.violations) return violation(controller, v.violations);
          if (v.release) {
            shownText += v.release;
            yield { type: "text", text: v.release };
          }
        }
        for await (const ev of this.opts.provider.stream(req, signal)) {
          if (ev.type === "text_delta") {
            text.push(ev.text);
            draftText += ev.text;
            const v = guard.push(ev.text);
            if (v.release) {
              shownText += v.release;
              yield { type: "text", text: v.release };
            }
            if (v.violations) return violation(controller, v.violations);
          } else if (ev.type === "tool_call") {
            calls.push(ev.call);
          } else {
            stop = ev.stop;
            raw = ev.raw;
            error = ev.error;
            await track(ev.usage);
          }
        }
        if (outerSignal.aborted) return result("aborted");
        if (stop === "refusal") return result("refused");
        if (stop === "error") return result("error", { error: error ?? new Error("The model stopped unexpectedly.") });
        if (stop === "max_tokens" && calls.length) {
          // A truncated tool input can still parse; never run it.
          return result("error", { error: new Error("The reply was cut off. Try asking a smaller question.") });
        }

        messages.push({
          role: "assistant",
          content: [
            ...(text.length ? [{ type: "text" as const, text: text.join("") }] : []),
            ...calls.map((call) => ({ type: "tool_call" as const, call })),
          ],
          raw: { provider: this.opts.provider.id, data: raw },
        });

        if (stop !== "tool_use" || calls.length === 0) {
          const v = guard.finish();
          if (v.release) {
            shownText += v.release;
            yield { type: "text", text: v.release };
          }
          if (v.violations) return violation(controller, v.violations);
          return result("ok");
        }

        // Step 4: run the calls; all results go back in one message, failures marked.
        const overLimit = round >= maxRounds;
        if (overLimit && round >= maxRounds + 2) {
          yield {
            type: "notice",
            kind: "tool_limit",
            message: "I looked at a lot of files there; let me stop and ask you instead.",
          };
          return result("error", { error: new Error("Too many tool rounds in one turn.") });
        }
        for (const call of calls) yield { type: "tool_start", call };
        const results = overLimit
          ? calls.map((c) => ({
              callId: c.id,
              isError: true,
              content: "Tool limit reached for this turn. Reply to the student now with what you found.",
            }))
          : await this.opts.tools.executeAll(calls, this.opts.level, { ...this.opts.toolContext, signal });
        for (const [i, call] of calls.entries()) yield { type: "tool_end", call, result: results[i]! };
        messages.push({ role: "user", content: results.map((r) => ({ type: "tool_result" as const, result: r })) });
        if (round + 1 === maxRounds) {
          messages.push(
            systemText(
              "You have used this turn's tool budget. Summarize what you found for the student and ask them a question; do not call more tools.",
              "tool_budget_note",
            ),
          );
        }
      }
    } catch (err) {
      if (outerSignal.aborted) return result("aborted");
      return result("error", { error: err as Error });
    } finally {
      outerSignal.removeEventListener("abort", onAbort);
    }
  }

  private async commit(messages: Message[]): Promise<void> {
    this.history.push(...messages);
    for (const message of messages) await this.opts.session?.append({ type: "message", message });
  }
}
