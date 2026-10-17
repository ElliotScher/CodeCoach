// The apps and tests compile this file from source; the reference brings the *.md declaration with it.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./md.d.ts" />
import type { GuardrailLevel } from "@codecoach/core";

import type { Phase } from "./state.js";
import L0 from "../prompts/levels/L0.md";
import L1 from "../prompts/levels/L1.md";
import L2 from "../prompts/levels/L2.md";
import L3 from "../prompts/levels/L3.md";
import persona from "../prompts/persona.md";
import describe from "../prompts/phases/describe.md";
import experiment from "../prompts/phases/experiment.md";
import explain from "../prompts/phases/explain.md";
import fix from "../prompts/phases/fix.md";
import hypothesize from "../prompts/phases/hypothesize.md";
import idle from "../prompts/phases/idle.md";
import observe from "../prompts/phases/observe.md";
import refine from "../prompts/phases/refine.md";
import reflect from "../prompts/phases/reflect.md";
import rules from "../prompts/rules.md";

export interface PromptFile {
  name: string;
  version: number;
  body: string;
}

/** Splits `---\nversion: N\n---\nbody` front matter. */
export function parsePromptFile(name: string, text: string): PromptFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`prompt ${name} has no front matter`);
  const version = /^version:\s*(\d+)\s*$/m.exec(m[1]!);
  if (!version) throw new Error(`prompt ${name} has no version`);
  return { name, version: Number(version[1]), body: m[2]!.trim() };
}

export const PROMPTS = {
  persona: parsePromptFile("persona", persona),
  rules: parsePromptFile("rules", rules),
  levels: {
    L0: parsePromptFile("levels/L0", L0),
    L1: parsePromptFile("levels/L1", L1),
    L2: parsePromptFile("levels/L2", L2),
    L3: parsePromptFile("levels/L3", L3),
  } satisfies Record<GuardrailLevel, PromptFile>,
  phases: {
    idle: parsePromptFile("phases/idle", idle),
    describe: parsePromptFile("phases/describe", describe),
    hypothesize: parsePromptFile("phases/hypothesize", hypothesize),
    experiment: parsePromptFile("phases/experiment", experiment),
    observe: parsePromptFile("phases/observe", observe),
    refine: parsePromptFile("phases/refine", refine),
    fix: parsePromptFile("phases/fix", fix),
    reflect: parsePromptFile("phases/reflect", reflect),
    explain: parsePromptFile("phases/explain", explain),
  } satisfies Record<Phase, PromptFile>,
};
