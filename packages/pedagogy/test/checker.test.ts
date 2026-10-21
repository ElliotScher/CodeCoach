import { describe, expect, test } from "vitest";

import type { GuardrailLevel } from "@codecoach/core";
import { normalizeLine } from "@codecoach/core";

import { ResponseChecker, checkResponse, findBannedPhrases } from "../src/index.js";
import type { CheckContext } from "../src/index.js";

const ctx = (level: GuardrailLevel, extra: Partial<CheckContext> = {}): CheckContext => ({
  level,
  attempts: 0,
  isStudentLine: () => false,
  ...extra,
});

const fence = (lang: string, ...lines: string[]) => ["```" + lang, ...lines, "```"].join("\n");
const kinds = (text: string, c: CheckContext) => checkResponse(text, c).violations.map((v) => v.kind);

const FIX = fence(
  "java",
  "m_drive.setDefaultCommand(",
  "    new RunCommand(() -> m_drive.arcadeDrive(-m_controller.getLeftY(), -m_controller.getRightX()), m_drive));",
  'm_drive.setName("Drive");',
);

describe("level limits", () => {
  test("L0 allows a 2-line signature but not the fix", () => {
    expect(
      kinds(
        `The method looks like this:\n${fence("java", "void setDefaultCommand(Command defaultCommand)")}\nWhere do you set one?`,
        ctx("L0"),
      ),
    ).toEqual([]);
    expect(kinds(`Add this:\n${FIX}`, ctx("L0"))).toEqual(["code_lines"]);
  });

  test("L0 counts pseudocode as code", () => {
    expect(
      kinds(
        fence("pseudo", "when teleop starts", "  tell the drivetrain to follow the joystick", "  forever"),
        ctx("L0"),
      ),
    ).toEqual(["pseudocode"]);
  });

  test("L1 allows pseudocode but no code", () => {
    expect(
      kinds(fence("text", "when teleop starts", "  drivetrain follows the joystick", "  until disabled"), ctx("L1")),
    ).toEqual([]);
    expect(kinds(fence("java", "int x = 1;"), ctx("L1"))).toEqual(["code_lines"]);
  });

  test("L2 allows up to 8 lines only after an attempt", () => {
    expect(kinds(FIX, ctx("L2"))).toEqual(["code_lines"]);
    expect(kinds(FIX, ctx("L2", { attempts: 1 }))).toEqual([]);
    const nine = fence("java", ...Array.from({ length: 9 }, (_, i) => `int x${i} = ${i};`));
    expect(kinds(nine, ctx("L2", { attempts: 1 }))).toEqual(["code_lines"]);
  });

  test("L3 allows code but never diffs in the reply", () => {
    expect(kinds(FIX, ctx("L3"))).toEqual([]);
    expect(kinds(fence("diff", "@@ -1 +1 @@", "-a", "+b"), ctx("L3"))).toEqual(["diff"]);
    expect(kinds(fence("", "- int x = 1;", "+ int x = 2;"), ctx("L3"))).toEqual(["diff"]);
  });

  test("quoting the student's own code is free", () => {
    const seen = new Set(["m_drive.setDefaultCommand(", 'm_drive.setName("Drive");'].map(normalizeLine));
    const own = ctx("L0", { isStudentLine: (l) => seen.has(normalizeLine(l)) });
    // Only one new line remains.
    expect(kinds(FIX, own)).toEqual([]);
  });

  test("blank, comment and lone-brace lines don't count", () => {
    expect(kinds(fence("java", "// look here", "", "}", "void periodic()", "{"), ctx("L0"))).toEqual([]);
  });

  test("the budget is per turn, across several fences", () => {
    const one = fence("java", "int a = 1;", "int b = 2;");
    expect(kinds(`${one}\nand\n${one}`, ctx("L0"))).toEqual(["code_lines"]);
  });
});

describe("unfenced code", () => {
  test("three code-like lines outside a fence are flagged below L3", () => {
    const text = "Try:\nint a = 1;\nint b = 2;\nint c = 3;\nWhat happens?";
    expect(kinds(text, ctx("L1"))).toEqual(["unfenced_code"]);
    expect(kinds(text, ctx("L3"))).toEqual([]);
  });

  test("two code-like lines are released", () => {
    expect(checkResponse("Here:\nint a = 1;\nint b = 2;\nok?", ctx("L0")).ok).toBe(true);
  });

  test("Python def headers count", () => {
    expect(
      kinds("def teleopPeriodic(self):\ndef robotInit(self):\nclass MyRobot(wpilib.TimedRobot):\n", ctx("L0")),
    ).toEqual(["unfenced_code"]);
  });
});

describe("banned phrases", () => {
  test.each([
    ["Just add the default command.", ["just"]],
    ["This is simply a scheduling issue.", ["simply"]],
    ["Obviously the motor is inverted.", ["obviously"]],
    ["That's an easy fix!", ["easy"]],
    ["It's trivial to check.", ["trivial"]],
    ["As everyone knows, PID needs tuning.", ["as everyone knows"]],
  ])("%s", (text, phrases) => {
    expect(findBannedPhrases(text).map((p) => p.phrase)).toEqual(phrases);
  });

  test.each([
    "This isn't easy, and being stuck here is normal.",
    "It's easy to miss in a big file.",
    "Gradle compiles just-in-time? No, ahead of time.",
    "It works just like the joystick example.",
    "Call `justDrive()` and see.",
    "Adjust the gains a little.",
  ])("allows: %s", (text) => {
    expect(findBannedPhrases(text)).toEqual([]);
  });

  test("phrases inside code blocks are ignored", () => {
    expect(checkResponse(fence("java", "// just a comment"), ctx("L0")).ok).toBe(true);
  });
});

describe("streaming", () => {
  function stream(text: string, c: CheckContext, chunk = 3) {
    const checker = new ResponseChecker(c);
    let shown = "";
    for (let i = 0; i < text.length; i += chunk) {
      const v = checker.push(text.slice(i, i + chunk));
      shown += v.release;
      if (v.violations) return { shown, violations: v.violations };
    }
    const v = checker.finish();
    return { shown: shown + v.release, violations: v.violations ?? [] };
  }

  test("releases prose before the turn ends, a sentence at a time", () => {
    const checker = new ResponseChecker(ctx("L0"));
    expect(checker.push("Good thinking. What happens wh").release).toBe("Good thinking. ");
    expect(checker.push("en you press A? ").release).toBe("What happens when you press A? ");
  });

  test("passing replies come out byte-for-byte, whatever the chunking", () => {
    const text = `Nice work checking the wiring.\n${fence("java", "void setDefaultCommand(Command c)")}\nWhere is that called in your code?`;
    for (const size of [1, 2, 5, 17, 1000])
      expect(stream(text, ctx("L0"), size)).toEqual({ shown: text, violations: [] });
  });

  test("never shows a fenced fix before the violation stops the stream", () => {
    const r = stream(`Look at RobotContainer.\n${FIX}\nThen deploy.`, ctx("L0"), 4);
    expect(r.violations.map((v) => v.kind)).toEqual(["code_lines"]);
    expect(r.shown).toBe("Look at RobotContainer.\n");
    expect(r.shown).not.toContain("setDefaultCommand");
  });

  test("never shows unfenced code runs", () => {
    const r = stream("Do this:\nm_drive.setDefaultCommand(cmd);\nm_drive.enable();\nm_drive.go();\n", ctx("L0"), 2);
    expect(r.violations.map((v) => v.kind)).toEqual(["unfenced_code"]);
    expect(r.shown).toBe("Do this:\n");
  });

  test("an unclosed fence at the end is still checked", () => {
    expect(stream(`Here:\n\`\`\`java\n${"int a = 1;\n".repeat(3)}`, ctx("L0")).violations.map((v) => v.kind)).toEqual([
      "code_lines",
    ]);
  });
});
