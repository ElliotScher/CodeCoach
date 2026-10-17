// The apps and tests compile this file from source; the reference brings the *.md declaration with it.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./md.d.ts" />
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { addUsage, costUsd } from "@codecoach/core";
import type { Usage } from "@codecoach/core";
import { claudeCodeJson } from "@codecoach/providers";

import rubric from "../rubric.md";
import type { Scenario } from "./scenario.js";

export const JUDGE_MODEL = "claude-opus-5-5";

export const RUBRIC_ITEMS = ["a", "b", "c", "d", "e", "f"] as const;
export type RubricItem = (typeof RUBRIC_ITEMS)[number];
export const RUBRIC_LABELS: Readonly<Record<RubricItem, string>> = {
  a: "no solution beyond level",
  b: "hypothesis first",
  c: "correct diagnosis",
  d: "encouraging tone",
  e: "pointed to docs/tools",
  f: "student reached fix",
};

const Grade = z.object({
  pass: z.boolean(),
  evidence: z.string().describe("Short quote or turn reference supporting the grade."),
});
export const JudgeOutputSchema = z.object({
  a: Grade,
  b: Grade,
  c: Grade,
  d: Grade,
  e: Grade,
  f: Grade,
  summary: z.string().describe("Two sentences on how the mentor did."),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface TranscriptTurn {
  speaker: "student" | "coach";
  text: string;
  /** Coach tool calls this turn, summarized. */
  tools?: string[];
}

export function renderTranscript(turns: readonly TranscriptTurn[]): string {
  return turns
    .map((t, i) => {
      const tools = t.tools?.length ? `\n  [mentor used tools: ${t.tools.join("; ")}]` : "";
      return `--- Turn ${i + 1}: ${t.speaker === "coach" ? "MENTOR" : "STUDENT"}${tools}\n${t.text}`;
    })
    .join("\n\n");
}

export interface JudgeResult {
  output: JudgeOutput | null;
  usage: Usage;
  costUsd: number;
  error?: string;
}

export interface JudgeInput {
  scenario: Scenario;
  transcript: readonly TranscriptTurn[];
  fixCheck: boolean | null;
  level: string;
}

export const JUDGE_SYSTEM = `You grade transcripts of an AI mentor coaching high-school robotics students. Apply the rubric strictly and quote evidence.\n\n${rubric}`;

export function judgePrompt(opts: JudgeInput): string {
  return [
    `Guardrail level for this team: ${opts.level}`,
    `Planted bug: ${opts.scenario.bug}`,
    `Expected root cause: ${opts.scenario.expected.root_cause}`,
    `Files involved: ${opts.scenario.expected.files.join(", ")}`,
    `Deterministic fix check: ${opts.fixCheck === null ? "not applicable (environment problem; judge from the transcript)" : opts.fixCheck ? "PASSED (the student's files now contain the fix)" : "FAILED (the fix is not in the student's files)"}`,
    "",
    "<transcript>",
    renderTranscript(opts.transcript),
    "</transcript>",
  ].join("\n");
}

/** Grades one transcript against the rubric with Opus at high effort, structured output. */
export async function judgeTranscript(
  client: Anthropic,
  opts: {
    scenario: Scenario;
    transcript: readonly TranscriptTurn[];
    fixCheck: boolean | null;
    level: string;
    model?: string;
  },
): Promise<JudgeResult> {
  const model = opts.model ?? JUDGE_MODEL;
  const prompt = judgePrompt(opts);
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(JudgeOutputSchema) },
      ...(model === JUDGE_MODEL ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] } : {}),
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const cost = costUsd(model, usage);
    if (response.stop_reason === "refusal") return { output: null, usage, costUsd: cost, error: "judge refused" };
    return {
      output: response.parsed_output ?? null,
      usage,
      costUsd: cost,
      ...(response.parsed_output ? {} : { error: "judge output did not parse" }),
    };
  } catch (err) {
    return {
      output: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      error: String(err),
    };
  }
}

/**
 * The same judge on the Claude Code subscription transport (`--json-schema`),
 * validated with the Zod schema and retried once on invalid output.
 */
export async function judgeWithClaudeCode(
  opts: JudgeInput & { model?: string; json?: typeof claudeCodeJson },
): Promise<JudgeResult> {
  const call = opts.json ?? claudeCodeJson;
  const schema = z.toJSONSchema(JudgeOutputSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete schema["$schema"];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let error = "no output";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await call({
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(opts),
      schema,
      model: opts.model ?? "opus",
      effort: "high",
    });
    usage = addUsage(usage, r.usage);
    const parsed = JudgeOutputSchema.safeParse(r.output);
    if (parsed.success) return { output: parsed.data, usage, costUsd: 0 };
    error = r.error ?? z.prettifyError(parsed.error);
  }
  return { output: null, usage, costUsd: 0, error: `judge output invalid: ${error}` };
}
