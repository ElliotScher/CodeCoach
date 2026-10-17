import { describe, expect, test } from "vitest";

import {
  CoachingStateMachine,
  INITIAL_STATE,
  PROMPTS,
  applyUpdate,
  assemblePrompt,
  renderTurnContext,
  stableJson,
} from "../src/index.js";
import type { CoachingState } from "../src/index.js";

const at = (phase: CoachingState["phase"], extra: Partial<CoachingState> = {}): CoachingState => ({
  ...INITIAL_STATE,
  phase,
  ...extra,
});

describe("state machine", () => {
  test("the hypothesis gate blocks observe and fix", () => {
    for (const phase of ["observe", "fix"] as const) {
      const r = applyUpdate(at(phase === "fix" ? "refine" : "hypothesize"), { phase });
      expect(r).toEqual({ ok: false, reason: expect.stringMatching(/hypothesis first/) });
    }
    expect(
      applyUpdate(at("hypothesize"), { phase: "observe", studentHypothesis: "the controller ID is wrong" }),
    ).toMatchObject({
      ok: true,
      state: { phase: "observe", studentHypothesis: "the controller ID is wrong" },
    });
  });

  test("rejects transitions that skip ahead", () => {
    expect(applyUpdate(at("describe"), { phase: "fix" })).toEqual({
      ok: false,
      reason: expect.stringMatching(/Can't go from describe to fix/),
    });
  });

  test("fix → reflect needs the student to have made the change", () => {
    const fix = at("fix", { studentHypothesis: "x" });
    expect(applyUpdate(fix, { phase: "reflect" })).toMatchObject({ ok: false });
    expect(applyUpdate(fix, { phase: "reflect", studentMadeChange: true })).toMatchObject({
      ok: true,
      state: { phase: "reflect" },
    });
  });

  test("explain needs the escape hatch and one hypothesis prompt", () => {
    expect(applyUpdate(at("hypothesize"), { phase: "explain" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/asks to be told/),
    });
    expect(applyUpdate(at("describe", { escapeHatch: true }), { phase: "explain" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/one guess first/),
    });
    const asked = at("hypothesize", { escapeHatch: true, hypothesisPrompts: 1 });
    expect(applyUpdate(asked, { phase: "explain" })).toMatchObject({
      ok: true,
      state: { phase: "explain", escapeHatch: false },
    });
    // "I don't know" counts as an answer.
    expect(
      applyUpdate(at("describe", { escapeHatch: true }), { phase: "explain", studentHypothesis: "I don't know" }),
    ).toMatchObject({ ok: true });
  });

  test("records attempts and concepts, de-duplicated", () => {
    const r = applyUpdate(at("experiment", { concepts: ["default commands"] }), {
      attempt: "unplugged the controller",
      concepts: ["default commands", "scheduler"],
    });
    expect(r).toMatchObject({
      ok: true,
      state: { attempts: ["unplugged the controller"], concepts: ["default commands", "scheduler"] },
    });
  });

  test("the escape hatch latches across turns and counts hypothesis prompts", () => {
    const m = new CoachingStateMachine();
    m.update({ phase: "hypothesize" });
    m.endCoachTurn();
    m.beginStudentTurn({ escapeHatch: true });
    m.beginStudentTurn({ escapeHatch: false });
    expect(m.state).toMatchObject({ escapeHatch: true, hypothesisPrompts: 1 });
    expect(m.update({ phase: "explain" }).ok).toBe(true);
  });

  test("the tool turns rejections into tool errors", async () => {
    const m = new CoachingStateMachine();
    const tool = m.tool();
    await expect(tool.run({ phase: "fix" }, {} as never)).rejects.toThrow(/Can't go from idle to fix/);
    await expect(tool.run({ phase: "describe" }, {} as never)).resolves.toMatch(/phase=describe/);
  });
});

describe("prompt assembly", () => {
  const tools = [
    { name: "b_tool", description: "B", inputSchema: { type: "object", properties: { z: {}, a: {} } } },
    { name: "a_tool", description: "A", inputSchema: { properties: { a: {} }, type: "object" } },
  ];
  const base = {
    level: "L0" as const,
    profile: { language: "en", readingLevel: "standard" as const },
    projectSummary: "Language: java",
    tools,
  };

  test("same inputs give a byte-identical prefix and hash", () => {
    const a = assemblePrompt(base);
    const b = assemblePrompt({
      ...base,
      tools: tools.map((t) => ({ ...t, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) })),
    });
    expect(a.system).toEqual(b.system);
    expect(a.hash).toBe(b.hash);
    expect(a.system.map((s) => s.cacheBreakpoint)).toEqual([true, true]);
  });

  test("the hash changes with the level, tools or project", () => {
    const h = assemblePrompt(base).hash;
    expect(assemblePrompt({ ...base, level: "L1" }).hash).not.toBe(h);
    expect(assemblePrompt({ ...base, projectSummary: "Language: python" }).hash).not.toBe(h);
    expect(assemblePrompt({ ...base, tools: tools.slice(1) }).hash).not.toBe(h);
  });

  test("layer order: persona, rules, level, then the project in its own block", () => {
    const [core, project] = assemblePrompt(base).system;
    const i = (s: string) => core!.text.indexOf(s);
    expect(i(PROMPTS.persona.body)).toBe(0);
    expect(i(PROMPTS.rules.body)).toBeGreaterThan(0);
    expect(i(PROMPTS.levels.L0.body)).toBeGreaterThan(i(PROMPTS.rules.body));
    expect(project!.text).toContain("Language: java");
  });

  test("no volatile content in the cached layers", () => {
    const text = assemblePrompt(base)
      .system.map((s) => s.text)
      .join("\n");
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\d{1,2}:\d\d/);
  });

  test("replies in the student's language", () => {
    expect(
      assemblePrompt({ ...base, profile: { language: "es", readingLevel: "simplified" } }).system[0]!.text,
    ).toMatch(/Reply in Spanish.*\n- Use short sentences/s);
  });

  test("stableJson sorts keys", () => {
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  test("every prompt file has a version", () => {
    for (const p of [
      PROMPTS.persona,
      PROMPTS.rules,
      ...Object.values(PROMPTS.levels),
      ...Object.values(PROMPTS.phases),
    ]) {
      expect(p.version).toBeGreaterThanOrEqual(1);
      expect(p.body.length).toBeGreaterThan(10);
    }
  });
});

describe("turn context", () => {
  test("renders phase, hypothesis and attempts", () => {
    const text = renderTurnContext(at("hypothesize", { attempts: ["printed joystick values"] }), {
      level: "L0",
      escapeHatch: false,
    });
    expect(text).toContain("Phase: hypothesize.");
    expect(text).toContain("hypothesis: none yet");
    expect(text).toContain('"printed joystick values"');
  });

  test("the escape hatch asks for a guess before explaining", () => {
    expect(renderTurnContext(at("describe"), { level: "L0", escapeHatch: true })).toMatch(/Ask for one guess first/);
    expect(renderTurnContext(at("hypothesize", { hypothesisPrompts: 1 }), { level: "L0", escapeHatch: true })).toMatch(
      /the cause, not the code/,
    );
  });
});
