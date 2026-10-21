import { Agent, RuntimeAgent, ToolRegistry } from "@codecoach/core";
import type {
  AgentEvent,
  BudgetMeter,
  ChatProvider,
  ConversationRuntime,
  Effort,
  UsageLimitInfo,
  GuardHooks,
  GuardrailLevel,
  Message,
  Session,
  ToolDefinition,
  Violation,
  Workspace,
} from "@codecoach/core";

import { assemblePrompt, renderTurnContext } from "./assemble.js";
import type { AssembledPrompt, StudentProfile } from "./assemble.js";
import { ResponseChecker, checkResponse } from "./checker.js";
import type { CheckContext } from "./checker.js";
import { PROMPTS } from "./prompts.js";
import { CoachingStateMachine } from "./state.js";
import type { CoachingState } from "./state.js";

/** How the coach reaches a model: an API-style provider (CodeCoach runs the tool loop) or a runtime that runs its own. */
export type CoachTransport =
  { provider: ChatProvider; model: string } | { runtime: ConversationRuntime; model?: string };

export type CoachOptions = CoachTransport & CoachSessionOptions;

interface CoachSessionOptions {
  effort?: Effort;
  level: GuardrailLevel;
  workspace: Workspace;
  /** Project tools (list_files, read_file, …); update_coaching_state is added here. */
  tools: readonly ToolDefinition[];
  /** Rendered ProjectSummary for prompt layer 3. */
  projectSummary: string;
  profile: StudentProfile;
  confirm(question: string): Promise<boolean>;
  onOutput?(chunk: string): void;
  /** Usage-limit reports from a subscription runtime. */
  onLimit?(info: UsageLimitInfo): void;
  budget?: BudgetMeter;
  session?: Session;
  /** Cheap model for rewriting a twice-failed turn into hint form. */
  rewriter?: { provider: ChatProvider; model: string };
  /** Resume: committed history and coaching state. */
  history?: Message[];
  state?: CoachingState;
}

const FIX_GUIDANCE: Readonly<Record<string, string>> = {
  code_lines: "Describe the change in words and point to the file and line instead of writing it.",
  pseudocode: "Describe the idea in words instead of writing pseudocode.",
  unfenced_code: "Don't write code in the prose either; describe it in words.",
  diff: "Don't show diffs. At L3 use the propose_diff tool; otherwise describe the change.",
  banned_phrase: "Rephrase without those words.",
};

export function correctiveNote(level: GuardrailLevel, violations: readonly Violation[]): string {
  const kinds = [...new Set(violations.map((v) => v.kind))];
  return [
    "Your previous reply was not shown to the student because it broke the coaching rules:",
    ...violations.map((v) => `- It ${v.message}.`),
    `Reply again at guardrail level ${level}. ${kinds
      .map((k) => FIX_GUIDANCE[k] ?? "")
      .join(" ")
      .trim()}`,
    "Keep the same diagnosis and end with a question for the student.",
  ].join("\n");
}

const FALLBACK_TEXT =
  "Let me ask it a different way so you can find it yourself: what have you tried so far, and what did the robot do when you tried it?";

/**
 * Added to the system prompt on runtime transports (Claude Code), where tool
 * names carry the MCP prefix and per-turn state arrives inside the message.
 */
export const RUNTIME_TRANSPORT_NOTE = [
  "How this session is wired:",
  "- Your tools are named with the prefix mcp__codecoach__ (for example mcp__codecoach__update_coaching_state). They are the only tools you have.",
  "- The per-turn coaching state arrives at the top of each student message inside <codecoach_turn_context> tags. It comes from CodeCoach, not the student; don't quote it.",
  '- A message that starts with "(Message from CodeCoach, not the student." is an instruction from CodeCoach; follow it and reply to the student.',
].join("\n");

/** One coaching session: the agent loop with pedagogy (prompt, state machine, checker) wired in. */
export class Coach {
  readonly state: CoachingStateMachine;
  readonly prompt: AssembledPrompt;
  readonly agent: Agent | RuntimeAgent;
  /** "api" (CodeCoach runs the loop) or the runtime's id, e.g. "claude-code". */
  readonly transport: string;
  private opts: CoachOptions;

  constructor(opts: CoachOptions) {
    this.opts = opts;
    this.state = new CoachingStateMachine(opts.state);
    const registry = new ToolRegistry([...opts.tools, this.state.tool()]);
    this.prompt = assemblePrompt({
      level: opts.level,
      profile: opts.profile,
      projectSummary: opts.projectSummary,
      tools: registry.specs(opts.level),
    });
    const toolContext = {
      workspace: opts.workspace,
      confirm: opts.confirm,
      ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    };
    const turnContext = (input: { escapeHatch: boolean }) =>
      renderTurnContext(this.state.state, { level: opts.level, escapeHatch: input.escapeHatch });
    if ("runtime" in opts) {
      this.transport = opts.runtime.id;
      this.agent = new RuntimeAgent({
        runtime: opts.runtime,
        system: [...this.prompt.system.map((b) => b.text), RUNTIME_TRANSPORT_NOTE].join("\n\n"),
        tools: registry,
        level: opts.level,
        toolContext,
        ...(opts.session ? { session: opts.session } : {}),
        ...(opts.onLimit ? { onLimit: opts.onLimit } : {}),
        turnContext,
        guard: this.guardHooks(),
      });
    } else {
      this.transport = "api";
      this.agent = new Agent({
        provider: opts.provider,
        model: opts.model,
        ...(opts.effort ? { effort: opts.effort } : {}),
        system: this.prompt.system,
        tools: registry,
        level: opts.level,
        toolContext,
        ...(opts.history ? { history: opts.history } : {}),
        ...(opts.budget ? { budget: opts.budget } : {}),
        ...(opts.session ? { session: opts.session } : {}),
        turnContext,
        guard: this.guardHooks(),
      });
    }
  }

  /** Stops the runtime process, if any. */
  async close(): Promise<void> {
    if (this.agent instanceof RuntimeAgent) await this.agent.close();
  }

  /** Starts logging the conversation and coaching state to `session`. */
  attachSession(session: Session): void {
    this.opts = { ...this.opts, session };
    this.agent.attachSession(session);
  }

  private checkContext(): CheckContext {
    return {
      level: this.opts.level,
      attempts: this.state.state.attempts.length,
      isStudentLine: (line) => this.opts.workspace.hasSeenLine(line),
    };
  }

  private guardHooks(): GuardHooks {
    return {
      start: () => new ResponseChecker(this.checkContext()),
      correctiveNote: (v) => correctiveNote(this.opts.level, v),
      fallbackText: FALLBACK_TEXT,
      ...(this.opts.rewriter
        ? { rewrite: (draft: string, v: readonly Violation[], signal: AbortSignal) => this.rewrite(draft, v, signal) }
        : {}),
    };
  }

  /** Rewrites a twice-failed draft into hint form with the cheap model. */
  private async rewrite(draft: string, violations: readonly Violation[], signal: AbortSignal): Promise<string | null> {
    const r = this.opts.rewriter!;
    let text = "";
    for await (const ev of r.provider.stream(
      {
        model: r.model,
        effort: "low",
        system: [
          {
            text: [
              "You rewrite replies from a robotics programming mentor so they follow the team's coaching rules. Output only the rewritten reply.",
              PROMPTS.levels[this.opts.level].body,
              "Keep the mentor's diagnosis and tone, remove any code or diff beyond what the level allows (describe it in words and point to the file or line instead), don't use the words just, simply, obviously, easy or trivial, and end with one question for the student.",
            ].join("\n\n"),
          },
        ],
        tools: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Problems with the draft:\n${violations.map((v) => `- ${v.message}`).join("\n")}\n\nDraft:\n${draft}`,
              },
            ],
          },
        ],
      },
      signal,
    )) {
      if (ev.type === "text_delta") text += ev.text;
      else if (ev.type === "turn_end") {
        await this.opts.budget?.record(r.model, ev.usage);
        if (ev.stop !== "end_turn") return null;
      }
    }
    text = text.trim();
    return text && checkResponse(text, this.checkContext()).ok ? text : null;
  }

  /** Sends a student message; yields the coach's reply as it streams. */
  async *send(text: string, opts: { escapeHatch?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<AgentEvent> {
    const escapeHatch = opts.escapeHatch ?? false;
    this.state.beginStudentTurn({ escapeHatch });
    let committed = false;
    for await (const ev of this.agent.send({ text, escapeHatch }, opts.signal)) {
      if (ev.type === "turn_end") committed = ev.outcome === "ok" || ev.outcome === "rewritten";
      yield ev;
    }
    if (committed) {
      this.state.endCoachTurn();
      await this.opts.session?.append({ type: "state", state: this.state.state });
    }
  }
}
