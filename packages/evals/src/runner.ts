import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { BudgetMeter, Workspace, ZERO_USAGE, addUsage } from "@codecoach/core";
import type {
  AgentEvent,
  ChatProvider,
  ConversationRuntime,
  Effort,
  GuardrailLevel,
  Usage,
  UsageLimitInfo,
  Violation,
} from "@codecoach/core";
import { analyzeProject, frcTools, renderProjectSummary } from "@codecoach/frc";
import { Coach, checkResponse } from "@codecoach/pedagogy";
import type { CoachTransport } from "@codecoach/pedagogy";
import {
  ANTHROPIC_CHEAP_MODEL,
  AnthropicProvider,
  ClaudeCodeProvider,
  ClaudeCodeRuntime,
  DEFAULT_ANTHROPIC_MODEL,
  assertApiSpendAllowed,
  assertSubscriptionAuth,
} from "@codecoach/providers";

import { judgeTranscript, judgeWithClaudeCode } from "./judge.js";
import type { JudgeInput, JudgeResult, TranscriptTurn } from "./judge.js";
import { loadRun } from "./report.js";
import { fixCheckPasses } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import { SIMULATED_STUDENT_MODEL, SimulatedStudent } from "./student.js";
import type { StudentEdit } from "./student.js";

/**
 * How the eval reaches models. `claude-code` (the default) runs coach, student
 * and judge on the owner's Claude subscription. `api` bills an API key and
 * needs the spending gate opened (PLAN.md, Decisions → Spending).
 */
export type EvalTransport =
  | { kind: "claude-code"; coachModel?: string; studentModel?: string; judgeModel?: string }
  | { kind: "api"; allowApiSpend: boolean; model?: string };

export interface ScenarioResult {
  id: string;
  /** "claude-code" or "api"; results on different transports aren't directly comparable. */
  transport: string;
  provider: string;
  model: string;
  level: GuardrailLevel;
  promptHash: string;
  promptVersions: string;
  transcript: TranscriptTurn[];
  edits: StudentEdit[];
  studentStatus: "fixed" | "gave_up" | "max_turns" | "error";
  metrics: {
    coachTurns: number;
    /** Attempts the response checker discarded (never shown). */
    guardViolations: number;
    violationKinds: string[];
    /** Committed coach turns that still fail the checker (must be 0). */
    violationsShown: number;
    rewrites: number;
    /** Tool calls the sandbox refused for leaving the workspace (must be 0). */
    outsideWorkspaceCalls: number;
    toolCalls: number;
    fixCheck: boolean | null;
    /** Coach turn after which the fix check first passed. */
    turnsToFix: number | null;
    tokens: { coach: Usage; student: Usage; judge: Usage };
    /** Dollars billed: always 0 on a subscription. */
    costUsd: { coach: number; student: number; judge: number; total: number };
  };
  judge: JudgeResult;
  error?: string;
}

/** Per-scenario model access; tests inject scripted ones. */
export interface EvalModels {
  coach(): CoachTransport & { rewriter?: { provider: ChatProvider; model: string } };
  student(): { provider: ChatProvider; model?: string } | { runtime: ConversationRuntime };
  judge(input: JudgeInput): Promise<JudgeResult>;
}

export interface RunOptions {
  scenarios: Scenario[];
  /** Where runs/<timestamp>/ is written. */
  outDir: string;
  transport?: EvalTransport;
  effort?: Effort;
  /** API transport only: stop starting new scenarios once this much is billed. */
  maxUsd?: number;
  /** Continue a run that stopped (usage limit, Ctrl+C): finished scenarios are kept. */
  resumeDir?: string;
  /** Overrides the transport's models (tests). */
  models?: EvalModels;
  log?: (line: string) => void;
}

export interface EvalRun {
  dir: string;
  startedAt: string;
  transport: string;
  model: string;
  results: ScenarioResult[];
  skipped: string[];
  totalUsd: number;
  /** Set when the subscription's usage limit stopped the run; resume with --resume. */
  stoppedForLimit?: UsageLimitInfo;
}

const SANDBOX_REFUSAL = /outside the project folder|links outside the project folder/;

/** Hides JDKs from the resolver for scenarios about the student's environment. Returns a restore function. */
function hideJdks(majors: readonly number[]): () => void {
  const saved = new Map<string, string | undefined>();
  const hide = (k: string) => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  };
  for (const major of majors) {
    for (const k of Object.keys(process.env))
      if (k === `JAVA_HOME_${major}` || k.startsWith(`JAVA_HOME_${major}_`)) hide(k);
    const jh = process.env["JAVA_HOME"];
    if (jh && new RegExp(`(jdk|java|openjdk)[-_]?${major}\\b`, "i").test(jh)) hide("JAVA_HOME");
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** A copy of the fixture without the answer key or build output. */
function copyProject(scenario: Scenario): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `codecoach-eval-${scenario.id}-`));
  cpSync(scenario.dir, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(scenario.dir, src);
      return (
        !/^(scenario\.yaml|fixture\.json)$/.test(rel) &&
        !/(^|[\\/])(build|\.gradle|\.venv|__pycache__|\.pytest_cache)([\\/]|$)/.test(rel)
      );
    },
  });
  return dir;
}

function describeCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const arg = i["path"] ?? i["pattern"] ?? i["glob"] ?? i["phase"] ?? "";
  return arg ? `${name}(${String(arg)})` : name;
}

/** The real models for a transport. */
export function transportModels(
  transport: EvalTransport,
  effort: Effort | undefined,
  onLimit: (i: UsageLimitInfo) => void,
): EvalModels {
  if (transport.kind === "claude-code") {
    return {
      coach: () => {
        const model = transport.coachModel ?? "opus";
        return {
          runtime: new ClaudeCodeRuntime({ model, effort: effort ?? "medium" }),
          model,
          rewriter: { provider: new ClaudeCodeProvider(), model: "haiku" },
        };
      },
      student: () => ({ runtime: new ClaudeCodeRuntime({ model: transport.studentModel ?? "sonnet", effort: "low" }) }),
      judge: (input) => judgeWithClaudeCode({ ...input, model: transport.judgeModel ?? "opus" }),
    };
  }
  assertApiSpendAllowed("API evals", transport.allowApiSpend);
  void onLimit;
  return {
    coach: () => {
      const provider = new AnthropicProvider({ allowApiSpend: true });
      return {
        provider,
        model: transport.model ?? DEFAULT_ANTHROPIC_MODEL,
        rewriter: { provider, model: ANTHROPIC_CHEAP_MODEL },
      };
    },
    student: () => ({ provider: new AnthropicProvider({ allowApiSpend: true }), model: SIMULATED_STUDENT_MODEL }),
    judge: (input) => judgeTranscript(new Anthropic(), input),
  };
}

export async function runScenario(
  scenario: Scenario,
  opts: {
    models: EvalModels;
    transport: string;
    effort?: Effort;
    log?: (line: string) => void;
    limit?: () => UsageLimitInfo | null;
  },
): Promise<ScenarioResult> {
  const level = scenario.expected.level;
  const projectDir = copyProject(scenario);
  const restore = hideJdks(scenario.environment.hide_jdks);
  const coachBudget = new BudgetMeter();
  const studentBudget = new BudgetMeter();
  let coachTokens: Usage = ZERO_USAGE;
  let studentTokens: Usage = ZERO_USAGE;
  const transcript: TranscriptTurn[] = [];
  let guardViolations = 0;
  const violationKinds: string[] = [];
  let violationsShown = 0;
  let rewrites = 0;
  let outsideWorkspaceCalls = 0;
  let toolCalls = 0;
  let coachTurns = 0;
  let turnsToFix: number | null = null;
  let studentStatus: ScenarioResult["studentStatus"] = "max_turns";
  let error: string | undefined;

  const workspace = new Workspace(projectDir);
  const summary = await analyzeProject(new Workspace(projectDir));
  const coachModels = opts.models.coach();
  const { rewriter, ...coachTransport } = coachModels;
  const coach = new Coach({
    ...coachTransport,
    effort: opts.effort ?? "medium",
    level,
    workspace,
    tools: frcTools(),
    projectSummary: renderProjectSummary(summary),
    profile: { language: "en", readingLevel: "standard" },
    confirm: async () => true,
    budget: coachBudget,
    ...(rewriter ? { rewriter } : {}),
  });
  const student = new SimulatedStudent(scenario, {
    ...opts.models.student(),
    workspace: new Workspace(projectDir),
    budget: studentBudget,
  });

  try {
    let studentText = scenario.student.opening;
    transcript.push({ speaker: "student", text: studentText });
    let wrapUp = false;
    while (coachTurns < scenario.max_turns) {
      const events: AgentEvent[] = [];
      let text = "";
      const tools: string[] = [];
      const violations: Violation[] = [];
      for await (const ev of coach.send(studentText)) {
        events.push(ev);
        if (ev.type === "text") text += ev.text;
        else if (ev.type === "tool_start") {
          toolCalls++;
          tools.push(describeCall(ev.call.name, ev.call.input));
        } else if (ev.type === "tool_end" && ev.result.isError && SANDBOX_REFUSAL.test(ev.result.content)) {
          outsideWorkspaceCalls++;
        } else if (ev.type === "turn_end") {
          coachTokens = addUsage(coachTokens, ev.usage);
          violations.push(...ev.violations);
          if (ev.outcome === "rewritten") rewrites++;
          if (ev.outcome === "error" || ev.outcome === "refused") {
            const notice = events.find((e): e is Extract<AgentEvent, { type: "notice" }> => e.type === "notice");
            error = `coach turn ${coachTurns + 1}: ${notice?.message ?? ev.outcome}`;
          }
        }
      }
      coachTurns++;
      guardViolations += violations.length ? 1 : 0;
      violationKinds.push(...violations.map((v) => v.kind));
      const shownCheck = checkResponse(text, {
        level,
        attempts: coach.state.state.attempts.length,
        isStudentLine: (l) => workspace.hasSeenLine(l),
      });
      if (!shownCheck.ok) violationsShown++;
      transcript.push({ speaker: "coach", text, ...(tools.length ? { tools } : {}) });
      opts.log?.(`  coach ${coachTurns}: ${text.slice(0, 100).replace(/\n/g, " ")}${text.length > 100 ? "…" : ""}`);
      if (error || wrapUp) break;

      const reply = await student.reply(text);
      for (const ev of reply.events) if (ev.type === "turn_end") studentTokens = addUsage(studentTokens, ev.usage);
      if (opts.limit?.()?.status === "rejected") {
        error = "usage limit reached";
        break;
      }
      transcript.push({
        speaker: "student",
        text: reply.text + (reply.status === "fixed" ? " [FIXED]" : reply.status === "gave_up" ? " [GIVE UP]" : ""),
      });
      opts.log?.(`  student: ${reply.text.slice(0, 100).replace(/\n/g, " ")}`);
      if (turnsToFix === null && (await fixCheckPasses(scenario, projectDir))) turnsToFix = coachTurns;
      studentText = reply.text || "(no reply)";
      if (reply.status === "fixed") {
        studentStatus = "fixed";
        wrapUp = true; // one more coach turn to reflect
      } else if (reply.status === "gave_up") {
        studentStatus = "gave_up";
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    studentStatus = "error";
  } finally {
    restore();
    await coach.close().catch(() => undefined);
    await student.close().catch(() => undefined);
  }

  const fixCheck = await fixCheckPasses(scenario, projectDir);
  const judge =
    opts.limit?.()?.status === "rejected"
      ? { output: null, usage: ZERO_USAGE, costUsd: 0, error: "skipped: usage limit reached" }
      : await opts.models.judge({ scenario, transcript, fixCheck, level });
  rmSync(projectDir, { recursive: true, force: true });
  const coachUsd = coachBudget.sessionCostUsd;
  const studentUsd = studentBudget.sessionCostUsd;
  return {
    id: scenario.id,
    transport: opts.transport,
    provider: "runtime" in coachTransport ? coachTransport.runtime.id : coachTransport.provider.id,
    model: coachTransport.model ?? "?",
    level,
    promptHash: coach.prompt.hash,
    promptVersions: coach.prompt.versions,
    transcript,
    edits: student.edits,
    studentStatus,
    metrics: {
      coachTurns,
      guardViolations,
      violationKinds,
      violationsShown,
      rewrites,
      outsideWorkspaceCalls,
      toolCalls,
      fixCheck,
      turnsToFix,
      tokens: { coach: coachTokens, student: studentTokens, judge: judge.usage },
      costUsd: {
        coach: coachUsd,
        student: studentUsd,
        judge: judge.costUsd,
        total: coachUsd + studentUsd + judge.costUsd,
      },
    },
    judge,
    ...(error ? { error } : {}),
  };
}

export async function runEvals(opts: RunOptions): Promise<EvalRun> {
  const transport: EvalTransport = opts.transport ?? { kind: "claude-code" };
  let lastLimit: UsageLimitInfo | null = null;
  const onLimit = (i: UsageLimitInfo) => {
    lastLimit = i;
    if (i.status !== "allowed")
      opts.log?.(
        `  (subscription: ${i.status}${i.utilization !== undefined ? `, ${Math.round(i.utilization * 100)}% used` : ""})`,
      );
  };
  if (!opts.models && transport.kind === "claude-code") assertSubscriptionAuth();
  const models = withLimitTracking(opts.models ?? transportModels(transport, opts.effort, onLimit), onLimit);

  const startedAt = new Date().toISOString();
  const dir = opts.resumeDir ?? path.join(opts.outDir, startedAt.replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  const results: ScenarioResult[] = opts.resumeDir ? await loadRun(opts.resumeDir).catch(() => []) : [];
  const done = new Set(results.map((r) => r.id));
  const skipped: string[] = [];
  let totalUsd = results.reduce((n, r) => n + r.metrics.costUsd.total, 0);
  let stoppedForLimit: UsageLimitInfo | undefined;

  for (const scenario of opts.scenarios) {
    if (done.has(scenario.id)) continue;
    if (stoppedForLimit || (transport.kind === "api" && opts.maxUsd !== undefined && totalUsd >= opts.maxUsd)) {
      skipped.push(scenario.id);
      continue;
    }
    opts.log?.(`▶ ${scenario.id}`);
    const r = await runScenario(scenario, {
      models,
      transport: transport.kind,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.log ? { log: opts.log } : {}),
      limit: () => lastLimit,
    });
    if ((lastLimit as UsageLimitInfo | null)?.status === "rejected") {
      // Don't keep a scenario the limit cut short; --resume runs it again.
      stoppedForLimit = lastLimit!;
      skipped.push(scenario.id);
      opts.log?.(`  → stopped: the subscription's usage limit was reached`);
      continue;
    }
    totalUsd += r.metrics.costUsd.total;
    results.push(r);
    await fs.writeFile(path.join(dir, `${scenario.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
    const used =
      r.metrics.tokens.coach.outputTokens + r.metrics.tokens.student.outputTokens + r.metrics.tokens.judge.outputTokens;
    opts.log?.(
      `  → ${r.studentStatus}, fix check ${r.metrics.fixCheck}, ${used} output tokens${r.metrics.costUsd.total ? `, $${r.metrics.costUsd.total.toFixed(3)}` : ""}`,
    );
  }
  const model =
    transport.kind === "claude-code" ? (transport.coachModel ?? "opus") : (transport.model ?? DEFAULT_ANTHROPIC_MODEL);
  return {
    dir,
    startedAt,
    transport: transport.kind,
    model,
    results,
    skipped,
    totalUsd,
    ...(stoppedForLimit ? { stoppedForLimit } : {}),
  };
}

/** Wraps runtimes so usage-limit reports reach the runner. */
function withLimitTracking(models: EvalModels, onLimit: (i: UsageLimitInfo) => void): EvalModels {
  const track = (runtime: ConversationRuntime): ConversationRuntime => ({
    id: runtime.id,
    start: (o) => runtime.start(o),
    async *turn(text, signal) {
      for await (const ev of runtime.turn(text, signal)) {
        if (ev.type === "limit") onLimit(ev.info);
        yield ev;
      }
    },
    interrupt: () => runtime.interrupt(),
    close: () => runtime.close(),
  });
  return {
    coach: () => {
      const c = models.coach();
      return "runtime" in c ? { ...c, runtime: track(c.runtime) } : c;
    },
    student: () => {
      const s = models.student();
      return "runtime" in s ? { runtime: track(s.runtime) } : s;
    },
    judge: models.judge,
  };
}
