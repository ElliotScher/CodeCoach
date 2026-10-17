import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { BudgetMeter, Workspace } from "@codecoach/core";
import type { AgentEvent, ChatProvider, Effort, GuardrailLevel, Violation } from "@codecoach/core";
import { analyzeProject, frcTools, renderProjectSummary } from "@codecoach/frc";
import { Coach, checkResponse } from "@codecoach/pedagogy";
import { ANTHROPIC_CHEAP_MODEL, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "@codecoach/providers";

import { judgeTranscript } from "./judge.js";
import type { JudgeResult, TranscriptTurn } from "./judge.js";
import { fixCheckPasses } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import { SIMULATED_STUDENT_MODEL, SimulatedStudent } from "./student.js";
import type { StudentEdit } from "./student.js";

export interface ScenarioResult {
  id: string;
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
    costUsd: { coach: number; student: number; judge: number; total: number };
  };
  judge: JudgeResult;
  error?: string;
}

export interface RunOptions {
  scenarios: Scenario[];
  /** Where runs/<timestamp>/ is written. */
  outDir: string;
  model?: string;
  effort?: Effort;
  /** Stop starting new scenarios once total spend reaches this. */
  maxUsd?: number;
  /** Injected for tests; default to the real Anthropic API. */
  coachProvider?: ChatProvider;
  studentProvider?: ChatProvider;
  judge?: typeof judgeTranscript;
  judgeClient?: Anthropic;
  log?: (line: string) => void;
}

export interface EvalRun {
  dir: string;
  startedAt: string;
  model: string;
  results: ScenarioResult[];
  skipped: string[];
  totalUsd: number;
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

export async function runScenario(
  scenario: Scenario,
  opts: Omit<RunOptions, "scenarios" | "outDir">,
): Promise<ScenarioResult> {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const level = scenario.expected.level;
  const projectDir = copyProject(scenario);
  const restore = hideJdks(scenario.environment.hide_jdks);
  const coachProvider = opts.coachProvider ?? new AnthropicProvider();
  const studentProvider = opts.studentProvider ?? coachProvider;
  const coachBudget = new BudgetMeter();
  const studentBudget = new BudgetMeter();
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
  const studentWorkspace = new Workspace(projectDir);
  const summary = await analyzeProject(new Workspace(projectDir));
  const coach = new Coach({
    provider: coachProvider,
    model,
    effort: opts.effort ?? "medium",
    level,
    workspace,
    tools: frcTools(),
    projectSummary: renderProjectSummary(summary),
    profile: { language: "en", readingLevel: "standard" },
    confirm: async () => true,
    budget: coachBudget,
    rewriter: { provider: coachProvider, model: ANTHROPIC_CHEAP_MODEL },
  });
  const student = new SimulatedStudent(scenario, {
    provider: studentProvider,
    model: SIMULATED_STUDENT_MODEL,
    workspace: studentWorkspace,
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
      if (
        !checkResponse(text, {
          level,
          attempts: coach.state.state.attempts.length,
          isStudentLine: (l) => workspace.hasSeenLine(l),
        }).ok
      ) {
        violationsShown++;
      }
      transcript.push({ speaker: "coach", text, ...(tools.length ? { tools } : {}) });
      opts.log?.(`  coach ${coachTurns}: ${text.slice(0, 100).replace(/\n/g, " ")}${text.length > 100 ? "…" : ""}`);
      if (error || wrapUp) break;

      const reply = await student.reply(text);
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
  }

  const fixCheck = await fixCheckPasses(scenario, projectDir);
  const judge = await (opts.judge ?? judgeTranscript)(opts.judgeClient ?? new Anthropic(), {
    scenario,
    transcript,
    fixCheck,
    level,
  });
  rmSync(projectDir, { recursive: true, force: true });
  const coachUsd = coachBudget.sessionCostUsd;
  const studentUsd = studentBudget.sessionCostUsd;
  return {
    id: scenario.id,
    provider: coachProvider.id,
    model,
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
  const startedAt = new Date().toISOString();
  const dir = path.join(opts.outDir, startedAt.replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  const results: ScenarioResult[] = [];
  const skipped: string[] = [];
  let totalUsd = 0;
  for (const scenario of opts.scenarios) {
    if (opts.maxUsd !== undefined && totalUsd >= opts.maxUsd) {
      skipped.push(scenario.id);
      continue;
    }
    opts.log?.(`▶ ${scenario.id}`);
    const r = await runScenario(scenario, opts);
    totalUsd += r.metrics.costUsd.total;
    results.push(r);
    await fs.writeFile(path.join(dir, `${scenario.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
    opts.log?.(`  → ${r.studentStatus}, fix check ${r.metrics.fixCheck}, $${r.metrics.costUsd.total.toFixed(3)}`);
  }
  const run: EvalRun = { dir, startedAt, model: opts.model ?? DEFAULT_ANTHROPIC_MODEL, results, skipped, totalUsd };
  return run;
}
