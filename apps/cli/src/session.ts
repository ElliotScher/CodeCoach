import path from "node:path";

import { BudgetMeter, SessionStore, Workspace, dataDir, loadTeamConfig } from "@codecoach/core";
import type { Effort, GuardrailLevel, Session } from "@codecoach/core";
import { analyzeProject, frcTools, renderProjectSummary } from "@codecoach/frc";
import type { ProjectSummary } from "@codecoach/frc";
import { Coach } from "@codecoach/pedagogy";
import { ANTHROPIC_CHEAP_MODEL, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "@codecoach/providers";

export interface SessionOptions {
  project: string;
  provider: "anthropic";
  model?: string;
  level?: GuardrailLevel;
  effort?: Effort;
  confirm(question: string): Promise<boolean>;
  onOutput?(chunk: string): void;
  onProposedDiff?(p: { file: string; summary: string; diff: string }): void;
}

export interface StartedSession {
  coach: Coach;
  summary: ProjectSummary;
  session: Session;
  budget: BudgetMeter;
  level: GuardrailLevel;
  levelFromConfig: GuardrailLevel;
  model: string;
}

/** Wires a coaching session: team config, project analysis, tools, provider and session log. */
export async function startSession(opts: SessionOptions): Promise<StartedSession> {
  const root = path.resolve(opts.project);
  const config = await loadTeamConfig(root);
  const level = opts.level ?? config.guardrailLevel;
  const workspace = new Workspace(root);
  const summary = await analyzeProject(workspace);
  const model = opts.model ?? config.providers.models["anthropic"] ?? DEFAULT_ANTHROPIC_MODEL;
  const provider = new AnthropicProvider();
  const budget = new BudgetMeter({
    ledgerDir: dataDir(),
    ...(config.monthlyBudgetUsd !== undefined ? { monthlyCapUsd: config.monthlyBudgetUsd } : {}),
  });
  const tools = frcTools({ ...(opts.onProposedDiff ? { onProposedDiff: opts.onProposedDiff } : {}) });
  const coach = new Coach({
    provider,
    model,
    effort: opts.effort ?? "medium",
    level,
    workspace,
    tools,
    projectSummary: renderProjectSummary(summary),
    profile: { language: config.language, readingLevel: config.readingLevel },
    confirm: opts.confirm,
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    budget,
    rewriter: { provider, model: ANTHROPIC_CHEAP_MODEL },
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
  return { coach, summary, session, budget, level, levelFromConfig: config.guardrailLevel, model };
}
