import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { MockProvider } from "@codecoach/core";

import { agreement, fixCheckPasses, loadScenarios, renderReport, renderTranscript, runEvals } from "../src/index.js";
import type { JudgeResult } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

describe("scenarios", () => {
  test("all scenario files load and match their folders", async () => {
    const all = await loadScenarios(FIXTURES);
    expect(all.map((s) => s.id)).toEqual([
      "java-roborio-default-command-bug",
      "java-roborio-degrees-radians",
      "java-roborio-duplicate-can-id",
      "java-roborio-inverted-motor",
      "java-roborio-requirement-conflict",
      "java-roborio-sleep-in-periodic",
      "java-systemcore-wrong-jdk",
      "python-roborio-indentation-bug",
    ]);
    expect((await loadScenarios(FIXTURES, { smoke: true })).map((s) => s.id)).toEqual([
      "java-roborio-default-command-bug",
      "python-roborio-indentation-bug",
    ]);
    expect((await loadScenarios(FIXTURES, { glob: "java-roborio-d*" })).length).toBe(3);
  });

  test("every fix check fails on the unfixed fixture", async () => {
    for (const s of await loadScenarios(FIXTURES)) {
      expect.soft(await fixCheckPasses(s, s.dir), s.id).toBe(s.expected.fix_check ? false : null);
    }
  });

  test("the default-command fix check passes once the fix is made", async () => {
    const [s] = await loadScenarios(FIXTURES, { glob: "java-roborio-default-command-bug" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "fixcheck-"));
    cpSync(s!.dir, dir, { recursive: true, filter: (p) => !/[\\/](build|\.gradle)([\\/]|$)/.test(p) });
    const file = path.join(dir, "src/main/java/frc/robot/RobotContainer.java");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "configureBindings();",
        "m_drivetrain.setDefaultCommand(x);\n    configureBindings();",
      ),
    );
    expect(await fixCheckPasses(s!, dir)).toBe(true);
  });
});

const passAll: JudgeResult = {
  output: {
    a: { pass: true, evidence: "" },
    b: { pass: true, evidence: "" },
    c: { pass: true, evidence: "" },
    d: { pass: true, evidence: "" },
    e: { pass: true, evidence: "" },
    f: { pass: true, evidence: "" },
    summary: "Good coaching.",
  },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.01,
};

describe("runner", () => {
  test("coach and simulated student converse until the student fixes it; the answer key is hidden", async () => {
    const [scenario] = await loadScenarios(FIXTURES, { glob: "java-roborio-default-command-bug" });
    const coach = new MockProvider([
      { calls: [{ id: "c1", name: "read_file", input: { path: "scenario.yaml" } }] },
      {
        text: "What do you think the drivetrain does when no command is running?",
        usage: { inputTokens: 1000, outputTokens: 50 },
      },
      { text: "Nice work. Why does that make the sticks work now?" },
    ]);
    const student = new MockProvider([
      {
        calls: [
          {
            id: "s1",
            name: "edit_file",
            input: {
              path: "src/main/java/frc/robot/RobotContainer.java",
              old_text: "    configureBindings();",
              new_text:
                "    m_drivetrain.setDefaultCommand(m_drivetrain.arcadeDriveCommand(() -> 0, () -> 0));\n    configureBindings();",
            },
          },
        ],
      },
      { text: "oh i think it needs a default command, i added one [FIXED]" },
    ]);
    let judged: unknown = null;
    const run = await runEvals({
      scenarios: [scenario!],
      outDir: mkdtempSync(path.join(os.tmpdir(), "runs-")),
      coachProvider: coach,
      studentProvider: student,
      judge: async (_client, opts) => ((judged = opts), passAll),
    });
    const r = run.results[0]!;
    expect(r.studentStatus).toBe("fixed");
    expect(r.metrics).toMatchObject({
      coachTurns: 2,
      fixCheck: true,
      turnsToFix: 1,
      violationsShown: 0,
      outsideWorkspaceCalls: 0,
      toolCalls: 1,
    });
    expect(r.transcript.map((t) => t.speaker)).toEqual(["student", "coach", "student", "coach"]);
    expect(r.edits).toHaveLength(1);
    // scenario.yaml was not copied into the student's project.
    const toolResult = coach.requests[1]!.messages.at(-1)!.content[0];
    expect(toolResult).toMatchObject({
      type: "tool_result",
      result: { isError: true, content: expect.stringMatching(/does not exist/) },
    });
    expect(judged).toMatchObject({ fixCheck: true, level: "L0" });
    expect(r.metrics.costUsd.coach).toBeCloseTo(0.005);
    expect(r.promptHash).toMatch(/^[0-9a-f]{16}$/);

    const report = renderReport(run);
    expect(report).toContain(
      "| java-roborio-default-command-bug | L0 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | fixed | 2 | 1 | 0 | 0 | 0 | 0 |",
    );
    expect(report).toContain("Guardrail violations shown to the student: 0 of 2 coach turns");
  });

  test("stops starting scenarios once the budget is spent", async () => {
    const scenarios = await loadScenarios(FIXTURES, { smoke: true });
    const run = await runEvals({
      scenarios,
      outDir: mkdtempSync(path.join(os.tmpdir(), "runs-")),
      maxUsd: 0.001,
      coachProvider: new MockProvider([{ text: "What have you tried?", usage: { inputTokens: 1000 } }]),
      studentProvider: new MockProvider([{ text: "nothing yet [GIVE UP]" }]),
      judge: async () => passAll,
    });
    expect(run.results.map((r) => r.id)).toEqual(["java-roborio-default-command-bug"]);
    expect(run.skipped).toEqual(["python-roborio-indentation-bug"]);
  });
});

describe("judge helpers", () => {
  test("transcripts render with speakers and tool use", () => {
    expect(
      renderTranscript([
        { speaker: "student", text: "hi" },
        { speaker: "coach", text: "hello", tools: ["read_file(a)"] },
      ]),
    ).toBe("--- Turn 1: STUDENT\nhi\n\n--- Turn 2: MENTOR\n  [mentor used tools: read_file(a)]\nhello");
  });

  test("agreement is computed per rubric item", () => {
    const human = { a: true, b: false, c: true, d: true, e: true, f: true };
    const a = agreement([{ human, judge: passAll }]);
    expect(a.find((x) => x.item === "a")).toEqual({ item: "a", agree: 1, total: 1, rate: 1 });
    expect(a.find((x) => x.item === "b")).toEqual({ item: "b", agree: 0, total: 1, rate: 0 });
  });
});
