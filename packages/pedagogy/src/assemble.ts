import { createHash } from "node:crypto";

import type { GuardrailLevel, SystemBlock, ToolSpec } from "@codecoach/core";

import { PROMPTS } from "./prompts.js";
import type { CoachingState } from "./state.js";

export interface StudentProfile {
  experience?: "new" | "some" | "experienced";
  /** BCP 47 language tag for replies. */
  language: string;
  readingLevel: "standard" | "simplified";
}

export interface AssembledPrompt {
  system: SystemBlock[];
  /** Content hash of tools + system, recorded with every session and eval transcript. */
  hash: string;
  /** "persona@1 rules@1 levels/L0@1" */
  versions: string;
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  zh: "Chinese",
};

function profileText(p: StudentProfile): string {
  const lines = ["About the student:"];
  if (p.experience === "new") lines.push("- New to programming. Explain terms the first time you use them.");
  else if (p.experience === "some") lines.push("- Has some programming experience.");
  else if (p.experience === "experienced") lines.push("- An experienced student programmer.");
  else lines.push("- Experience level unknown; find out from how they write.");
  const lang = p.language.split("-")[0]!;
  if (lang !== "en")
    lines.push(`- Reply in ${LANGUAGE_NAMES[lang] ?? p.language}. Keep code identifiers and API names in English.`);
  if (p.readingLevel === "simplified") lines.push("- Use short sentences and everyday words.");
  return lines.join("\n");
}

/**
 * Layers 1–3 of the prompt, in cache order:
 *   1. tools (passed separately, sorted by name),
 *   2. persona + coaching rules + guardrail level + student profile  → breakpoint 1,
 *   3. project summary                                              → breakpoint 2.
 * Nothing volatile (timestamps, unsorted data) goes in here; per-turn state
 * goes in renderTurnContext, sent as a system message after the student turn.
 */
export function assemblePrompt(opts: {
  level: GuardrailLevel;
  profile: StudentProfile;
  projectSummary: string;
  tools: readonly ToolSpec[];
}): AssembledPrompt {
  const core = [
    PROMPTS.persona.body,
    PROMPTS.rules.body,
    PROMPTS.levels[opts.level].body,
    profileText(opts.profile),
  ].join("\n\n");
  const project = `The student's robot project (from CodeCoach's analyzer; verify details with the tools when it matters):\n${opts.projectSummary}`;
  const system: SystemBlock[] = [
    { text: core, cacheBreakpoint: true },
    { text: project, cacheBreakpoint: true },
  ];
  const hash = createHash("sha256")
    .update(stableJson(opts.tools))
    .update("\u0000")
    .update(system.map((b) => b.text).join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  const versions = [PROMPTS.persona, PROMPTS.rules, PROMPTS.levels[opts.level]]
    .map((p) => `${p.name}@${p.version}`)
    .join(" ");
  return { system, hash, versions };
}

/** JSON with sorted object keys, so equal values always serialize to equal bytes. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/** Layer 5: the per-turn coaching context. */
export function renderTurnContext(state: CoachingState, opts: { level: GuardrailLevel; escapeHatch: boolean }): string {
  const lines = [
    "Coaching state for this turn (for you, not the student):",
    `- Phase: ${state.phase}. ${PROMPTS.phases[state.phase].body}`,
    `- Student's hypothesis: ${state.studentHypothesis ? JSON.stringify(state.studentHypothesis) : "none yet"}`,
    `- What they've tried: ${state.attempts.length ? state.attempts.map((a) => JSON.stringify(a)).join("; ") : "nothing recorded"}`,
    `- Concepts covered: ${state.concepts.join(", ") || "none yet"}`,
  ];
  if (opts.level === "L2")
    lines.push(
      `- Snippets: ${state.attempts.length ? "allowed (the student has made an attempt), at most 8 lines" : "not yet; the student hasn't made an attempt"}`,
    );
  if (opts.escapeHatch || state.escapeHatch) {
    const asked = state.hypothesisPrompts >= 1 || state.studentHypothesis !== null;
    lines.push(
      asked
        ? `- The student asked you to tell them. You can now explain the cause (set phase to explain)${opts.level === "L0" || opts.level === "L1" ? ", in words: the cause, not the code" : ""}.`
        : '- The student asked you to tell them. Ask for one guess first (any guess, even "I don\'t know"), then explain.',
    );
  }
  return lines.join("\n");
}
