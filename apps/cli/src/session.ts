import path from "node:path";

import { BudgetMeter, SessionStore, Workspace, dataDir, loadTeamConfig } from "@codecoach/core";
import type { Effort, GuardrailLevel, Session, UsageLimitInfo } from "@codecoach/core";
import { analyzeProject, frcTools, renderProjectSummary } from "@codecoach/frc";
import type { ProjectSummary } from "@codecoach/frc";
import { Coach } from "@codecoach/pedagogy";
import type { CoachTransport } from "@codecoach/pedagogy";
import {
  ANTHROPIC_CHEAP_MODEL,
  AnthropicProvider,
  ClaudeCodeProvider,
  ClaudeCodeRuntime,
  DEFAULT_ANTHROPIC_MODEL,
  assertSubscriptionAuth,
} from "@codecoach/providers";

/**
 * `claude-code`: the owner's Claude Pro/Max subscription through Claude Code
 * (the default; development-only). `anthropic`: the API, which bills a key and
 * is off unless `allowApiSpend` is set (PLAN.md, Decisions → Spending).
 */
export type ProviderChoice = "claude-code" | "anthropic";

export interface SessionOptions {
  project: string;
  provider: ProviderChoice;
  model?: string;
  level?: GuardrailLevel;
  effort?: Effort;
  allowApiSpend?: boolean;
  confirm(question: string): Promise<boolean>;
  onOutput?(chunk: string): void;
  onProposedDiff?(p: { file: string; summary: string; diff: string }): void;
  onLimit?(info: UsageLimitInfo): void;
}

export interface StartedSession {
  coach: Coach;
  summary: ProjectSummary;
  session: Session;
  budget: BudgetMeter;
  level: GuardrailLevel;
  levelFromConfig: GuardrailLevel;
  model: string;
  /** e.g. "your Claude pro subscription through Claude Code" */
  via: string;
}

/** Wires a coaching session: team config, project analysis, tools, transport and session log. */
export async function startSession(opts: SessionOptions): Promise<StartedSession> {
  const root = path.resolve(opts.project);
  const config = await loadTeamConfig(root);
  const level = opts.level ?? config.guardrailLevel;
  const workspace = new Workspace(root);
  const summary = await analyzeProject(workspace);
  const budget = new BudgetMeter({
    ledgerDir: dataDir(),
    ...(config.monthlyBudgetUsd !== undefined ? { monthlyCapUsd: config.monthlyBudgetUsd } : {}),
  });

  let transport: CoachTransport;
  let rewriter: { provider: ClaudeCodeProvider | AnthropicProvider; model: string };
  let model: string;
  let via: string;
  if (opts.provider === "claude-code") {
    const auth = assertSubscriptionAuth();
    model = opts.model ?? "opus";
    const runtime = new ClaudeCodeRuntime({ model, ...(opts.effort ? { effort: opts.effort } : {}) });
    transport = { runtime, model };
    rewriter = { provider: new ClaudeCodeProvider(), model: "haiku" };
    via = `your Claude ${auth.subscriptionType ? `${auth.subscriptionType} ` : ""}subscription through Claude Code`;
  } else {
    model = opts.model ?? config.providers.models["anthropic"] ?? DEFAULT_ANTHROPIC_MODEL;
    const provider = new AnthropicProvider({ ...(opts.allowApiSpend ? { allowApiSpend: true } : {}) });
    transport = { provider, model };
    rewriter = { provider, model: ANTHROPIC_CHEAP_MODEL };
    via = "the Anthropic API (billed to your API key)";
  }

  const tools = frcTools({ ...(opts.onProposedDiff ? { onProposedDiff: opts.onProposedDiff } : {}) });
  const coach = new Coach({
    ...transport,
    effort: opts.effort ?? "medium",
    level,
    workspace,
    tools,
    projectSummary: renderProjectSummary(summary),
    profile: { language: config.language, readingLevel: config.readingLevel },
    confirm: opts.confirm,
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    ...(opts.onLimit ? { onLimit: opts.onLimit } : {}),
    budget,
    rewriter,
  });
  const store = new SessionStore(path.join(dataDir(), "sessions"));
  const session = await store.create({
    projectRoot: root,
    provider: opts.provider,
    model,
    level,
    promptHash: coach.prompt.hash,
  });
  // The coach is built first so the session can record its prompt hash.
  coach.attachSession(session);
  return { coach, summary, session, budget, level, levelFromConfig: config.guardrailLevel, model, via };
}
