import type { AgentEvent, TurnInput } from "./agent.js";
import type { GuardHooks, StreamGuard, Violation } from "./guard.js";
import { PASSTHROUGH_GUARD } from "./guard.js";
import type { ConversationRuntime, UsageLimitInfo } from "./runtime.js";
import type { Session } from "./session-store.js";
import type { ToolContext, ToolRegistry } from "./tools/registry.js";
import type { GuardrailLevel, Message, ToolCall, Usage } from "./types.js";
import { ZERO_USAGE, addUsage } from "./types.js";

/** Stop a turn that calls more tools than this (the runtime runs its own loop). */
export const DEFAULT_MAX_RUNTIME_TOOL_CALLS = 24;

export interface RuntimeAgentOptions {
  runtime: ConversationRuntime;
  /** Fixed for the session. */
  system: string;
  tools: ToolRegistry;
  level: GuardrailLevel;
  toolContext: Omit<ToolContext, "signal">;
  /** Per-turn coaching context, prepended to the student's message in a marked block. */
  turnContext?: (input: TurnInput) => string | null;
  guard?: GuardHooks;
  session?: Session;
  maxToolCalls?: number;
  /** Called with each usage-limit report from the runtime. */
  onLimit?: (info: UsageLimitInfo) => void;
}

/** One streamed reply from the runtime, passed through a guard. */
interface Reply {
  status: "ok" | "violation" | "error" | "aborted" | "limit";
  text: string;
  violations: Violation[];
  message?: string;
}

/**
 * The turn loop for runtimes that own the conversation (stage 1b). Same
 * events as `Agent`, but a blocked reply can't be removed from the runtime's
 * history, so it's interrupted and followed by a "rephrase as a hint" turn;
 * the student only ever sees the rephrased reply.
 */
export class RuntimeAgent {
  private readonly transcript: Message[] = [];
  private opts: RuntimeAgentOptions;
  private readonly guard: GuardHooks;
  private started: Promise<void> | null = null;

  constructor(opts: RuntimeAgentOptions) {
    this.opts = opts;
    this.guard = opts.guard ?? PASSTHROUGH_GUARD;
  }

  /** What the student saw, for logs and evals (the runtime keeps the real history). */
  get messages(): readonly Message[] {
    return this.transcript;
  }

  attachSession(session: Session): void {
    this.opts = { ...this.opts, session };
  }

  private start(): Promise<void> {
    this.started ??= this.opts.runtime.start({
      system: this.opts.system,
      tools: this.opts.tools.specs(this.opts.level),
      // Tool calls arrive from the runtime's MCP client; abort follows the turn.
      callTool: (call) =>
        this.opts.tools.execute(call, this.opts.level, { ...this.opts.toolContext, signal: this.turnSignal }),
    });
    return this.started;
  }

  private turnSignal: AbortSignal = new AbortController().signal;

  async close(): Promise<void> {
    await this.opts.runtime.close();
  }

  async *send(input: TurnInput, signal: AbortSignal = new AbortController().signal): AsyncGenerator<AgentEvent> {
    let usage: Usage = ZERO_USAGE;
    const violations: Violation[] = [];
    const end = (outcome: "ok" | "rewritten" | "error" | "aborted"): AgentEvent => ({
      type: "turn_end",
      outcome,
      usage,
      costUsd: 0, // subscription: no per-call price
      violations,
    });
    try {
      await this.start();
    } catch (err) {
      yield { type: "notice", kind: "error", message: err instanceof Error ? err.message : String(err) };
      yield end("error");
      return;
    }
    this.turnSignal = signal;

    const context = this.opts.turnContext?.(input);
    const message = context
      ? `<codecoach_turn_context>\n${context}\n</codecoach_turn_context>\n\nStudent:\n${input.text}`
      : input.text;
    const onUsage = (u: Usage) => (usage = addUsage(usage, u));

    let reply = yield* this.reply(message, signal, onUsage, true);
    if (reply.status === "violation") {
      violations.push(...reply.violations);
      await this.opts.session?.append({ type: "event", name: "guard_violation", data: reply.violations });
      yield { type: "notice", kind: "rewording", message: "Let me put that as a hint instead…" };
      const note = `(Message from CodeCoach, not the student. The student did not see your last reply.)\n${this.guard.correctiveNote(reply.violations)}`;
      reply = yield* this.reply(note, signal, onUsage, false);
      if (reply.status === "violation") {
        violations.push(...reply.violations);
        // Twice blocked: the runtime has no cheap side channel, so use the fallback.
        const rewritten =
          (await this.guard.rewrite?.(reply.text, reply.violations, signal).catch(() => null)) ??
          this.guard.fallbackText;
        yield { type: "text", text: rewritten };
        await this.log(input.text, rewritten, true);
        yield end("rewritten");
        return;
      }
    }
    if (reply.status === "aborted") {
      yield end("aborted");
      return;
    }
    if (reply.status === "error" || reply.status === "limit") {
      yield { type: "notice", kind: "error", message: reply.message ?? "The coach stopped unexpectedly." };
      yield end("error");
      return;
    }
    await this.log(input.text, reply.text, false);
    yield end("ok");
  }

  /** Streams one runtime turn through a fresh guard, interrupting it on the first violation. */
  private async *reply(
    text: string,
    signal: AbortSignal,
    onUsage: (u: Usage) => void,
    showTools: boolean,
  ): AsyncGenerator<AgentEvent, Reply> {
    const guard: StreamGuard = this.guard.start();
    let shown = "";
    let draft = "";
    let toolCalls = 0;
    const calls = new Map<string, ToolCall>();
    let failed: Violation[] | null = null;
    let stopMessage: string | undefined;
    const max = this.opts.maxToolCalls ?? DEFAULT_MAX_RUNTIME_TOOL_CALLS;
    const interrupt = () => void this.opts.runtime.interrupt().catch(() => undefined);
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      for await (const ev of this.opts.runtime.turn(text, signal)) {
        if (ev.type === "text_delta") {
          draft += ev.text;
          if (failed) continue; // draining the interrupted turn
          const v = guard.push(ev.text);
          if (v.release) {
            shown += v.release;
            yield { type: "text", text: v.release };
          }
          if (v.violations) {
            failed = v.violations;
            interrupt();
          }
        } else if (ev.type === "tool_start") {
          toolCalls++;
          calls.set(ev.call.id, ev.call);
          if (showTools && !failed) yield { type: "tool_start", call: ev.call };
          if (toolCalls > max && !stopMessage) {
            stopMessage = "I looked at a lot of files there; let me stop and ask you instead.";
            yield { type: "notice", kind: "tool_limit", message: stopMessage };
            interrupt();
          }
        } else if (ev.type === "tool_end") {
          const call = calls.get(ev.callId) ?? { id: ev.callId, name: "?", input: null };
          if (showTools && !failed) yield { type: "tool_end", call, result: ev.result };
        } else if (ev.type === "limit") {
          this.opts.onLimit?.(ev.info);
          if (ev.info.status === "rejected") stopMessage = limitMessage(ev.info);
        } else {
          onUsage(ev.usage);
          if (signal.aborted) return { status: "aborted", text: draft, violations: [] };
          if (failed) return { status: "violation", text: draft, violations: failed };
          if (stopMessage) return { status: "limit", text: draft, violations: [], message: stopMessage };
          if (ev.stop === "error" || ev.stop === "refusal" || ev.stop === "interrupted") {
            return {
              status: "error",
              text: draft,
              violations: [],
              message: ev.error?.message ?? "The coach stopped unexpectedly.",
            };
          }
          const v = guard.finish();
          if (v.release) {
            shown += v.release;
            yield { type: "text", text: v.release };
          }
          if (v.violations) return { status: "violation", text: draft, violations: v.violations };
          return { status: "ok", text: shown, violations: [] };
        }
      }
      return {
        status: signal.aborted ? "aborted" : "error",
        text: draft,
        violations: [],
        message: "The coach's runtime exited.",
      };
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  }

  private async log(student: string, coach: string, rewritten: boolean): Promise<void> {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: student }] },
      {
        role: "assistant",
        content: [{ type: "text", text: coach }],
        ...(rewritten ? { meta: { rewritten: true } } : {}),
      },
    ];
    this.transcript.push(...messages);
    for (const m of messages) await this.opts.session?.append({ type: "message", message: m });
  }
}

function limitMessage(info: UsageLimitInfo): string {
  const when = info.resetsAt ? ` It resets at ${new Date(info.resetsAt).toLocaleTimeString()}.` : "";
  return `The Claude subscription's usage limit is reached for now.${when}`;
}
