import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { candidateHomes, outline, parseBuildOutput, renderOutline, requiredJdk, resolveJdk } from "../src/index.js";
import type { JdkEnvironment } from "../src/index.js";

const log = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/build-logs/${name}`, import.meta.url)), "utf8");
const ROOT = "/home/student/robot";

describe("requiredJdk", () => {
  test.each([
    [{ controller: "roborio" as const }, 17],
    [{ controller: "systemcore" as const }, 25],
    [{ controller: null }, 17],
    [{ controller: "roborio" as const, toolchainVersion: 21 }, 21],
  ])("%j needs %d", (project, major) => {
    expect(requiredJdk(project).major).toBe(major);
  });

  test("reports a toolchain that disagrees with the controller", () => {
    expect(requiredJdk({ controller: "systemcore", toolchainVersion: 17 }).conflict).toMatch(/JDK 25/);
  });
});

/** A fake filesystem of JDK homes: home → JAVA_VERSION. */
function fakeEnv(homes: Record<string, string>, extra: Partial<JdkEnvironment> = {}): JdkEnvironment {
  const files = new Map(Object.entries(homes).map(([h, v]) => [path.join(h, "release"), `JAVA_VERSION="${v}"\n`]));
  return {
    platform: "linux",
    arch: "x64",
    homedir: "/home/s",
    env: {},
    readFile: (p) => {
      const f = files.get(p);
      if (f === undefined) throw new Error("ENOENT");
      return f;
    },
    readdir: () => ["2025", "2026", "2027_alpha7"],
    exists: () => false,
    exec: () => "",
    ...extra,
  };
}

describe("resolveJdk", () => {
  test("lookup order: JAVA_HOME_N, arch variants (host first), WPILib (project season first), JAVA_HOME", () => {
    const sources = candidateHomes(
      25,
      "2027_alpha7",
      fakeEnv(
        {},
        {
          arch: "arm64",
          env: { JAVA_HOME: "/jh", JAVA_HOME_25_X64: "/x", JAVA_HOME_25_AARCH64: "/a", JAVA_HOME_25: "/p" },
        },
      ),
    ).map((c) => c.source);
    expect(sources).toEqual([
      "JAVA_HOME_25",
      "JAVA_HOME_25_AARCH64",
      "JAVA_HOME_25_X64",
      "WPILib 2027_alpha7",
      "WPILib 2026",
      "WPILib 2025",
      "JAVA_HOME",
    ]);
  });

  test("picks the WPILib JDK for the project's season", () => {
    const e = fakeEnv({ "/home/s/wpilib/2026/jdk": "17.0.16", "/home/s/wpilib/2027_alpha7/jdk": "25.0.4" });
    const r = resolveJdk(requiredJdk({ controller: "systemcore" }), "2027_alpha7", e);
    expect(r.chosen).toEqual({
      home: "/home/s/wpilib/2027_alpha7/jdk",
      version: "25.0.4",
      source: "WPILib 2027_alpha7",
    });
  });

  test("never trusts an ambient JAVA_HOME with the wrong version", () => {
    const e = fakeEnv({ "/jdk17": "17.0.20" }, { env: { JAVA_HOME: "/jdk17" }, readdir: () => [] });
    const r = resolveJdk(requiredJdk({ controller: "systemcore" }), "2027", e);
    expect(r.chosen).toBeUndefined();
    expect(r.diagnostic?.code).toBe("jdk-mismatch");
    expect(r.diagnostic?.message).toMatch(/needs Java 25 because the project targets SystemCore/);
    expect(r.diagnostic?.message).toMatch(/JAVA_HOME is Java 17/);
  });

  test("finds setup-java's _X64 variables and Windows WPILib paths", () => {
    const winRoot = "C:\\Users\\Public\\wpilib";
    const e = fakeEnv(
      { "C:\\jdk17": "17.0.20" },
      { platform: "win32", env: { JAVA_HOME_17_X64: "C:\\jdk17" }, readdir: () => ["2026"] },
    );
    const r = resolveJdk(requiredJdk({ controller: "roborio" }), "2026", e);
    expect(r.chosen?.source).toBe("JAVA_HOME_17_X64");
    expect(candidateHomes(17, "2026", e).map((c) => c.home)).toContain(`${winRoot}\\2026\\jdk`);
  });

  test("falls back to java on PATH", () => {
    const e = fakeEnv(
      {},
      { readdir: () => [], exec: () => '    java.home = /usr/lib/jvm/17\nopenjdk version "17.0.9" 2026-01-01\n' },
    );
    expect(resolveJdk(requiredJdk({ controller: "roborio" }), null, e).chosen).toEqual({
      home: "/usr/lib/jvm/17",
      version: "17.0.9",
      source: "java on PATH",
    });
  });
});

describe("parseBuildOutput", () => {
  test("javac errors through Gradle, once each, with the column", () => {
    const d = parseBuildOutput(log("gradle-javac.log"), ROOT);
    const javac = d.filter((x) => x.tool === "javac");
    expect(javac).toEqual([
      expect.objectContaining({
        file: "src/main/java/frc/robot/RobotContainer.java",
        line: 61,
        severity: "error",
        message: "cannot find symbol",
      }),
    ]);
    expect(javac[0]!.col).toBeGreaterThan(1);
    expect(javac[0]!.context).toContain("m_exampleSubsytem");
    expect(d.some((x) => x.tool === "gradle" && /Execution failed for task ':compileJava'/.test(x.message))).toBe(true);
  });

  test("javac syntax errors", () => {
    const javac = parseBuildOutput(log("gradle-javac-multi.log"), ROOT).filter((x) => x.tool === "javac");
    expect(javac).toEqual([expect.objectContaining({ line: 27, message: "';' expected" })]);
  });

  test("the wrong-JDK failure is reported from Gradle's 'What went wrong' block", () => {
    const d = parseBuildOutput(log("gradle-wrong-jdk.log"), ROOT);
    expect(d).toEqual([
      expect.objectContaining({ tool: "gradle", message: expect.stringMatching(/invalid source release: 25/) }),
    ]);
  });

  test("gcc", () => {
    const d = parseBuildOutput(log("gcc.log"), ROOT);
    expect(d.map((x) => [x.file, x.line, x.col])).toEqual([
      ["src/main/cpp/Robot.cpp", 5, 8],
      ["src/main/cpp/Robot.cpp", 7, 17],
      ["src/main/cpp/Robot.cpp", 9, 31],
    ]);
    expect(d[0]!.message).toMatch(/marked ‘override’, but does not override/);
  });

  test("MSVC", () => {
    const d = parseBuildOutput(log("msvc.log"));
    expect(d).toEqual([
      expect.objectContaining({
        file: "C:/Users/student/robot/src/main/cpp/Robot.cpp",
        line: 12,
        col: 8,
        severity: "error",
        tool: "msvc",
      }),
      expect.objectContaining({ line: 14, severity: "warning" }),
    ]);
    expect(d[0]!.message).toMatch(/^C3668:/);
  });

  test("Python tracebacks point at the innermost frame", () => {
    expect(parseBuildOutput(log("traceback.log"), ROOT)).toEqual([
      expect.objectContaining({
        tool: "python",
        file: "crash.py",
        line: 5,
        message: "ZeroDivisionError: division by zero",
      }),
    ]);
  });

  test("pytest failures", () => {
    const d = parseBuildOutput(log("pytest.log"), ROOT);
    expect(d).toContainEqual(
      expect.objectContaining({
        tool: "pytest",
        file: "tests/test_drive.py",
        line: 5,
        message: expect.stringContaining("AssertionError"),
      }),
    );
    expect(d).toContainEqual(
      expect.objectContaining({ tool: "pytest", message: expect.stringMatching(/^test_speed_is_clamped failed/) }),
    );
  });
});

describe("outline", () => {
  test("Java", async () => {
    const s = await outline(
      "java",
      "public class Drive extends SubsystemBase implements Sendable {\n  private final int m_a = 1, m_b;\n  public Drive() {}\n  void periodic() {}\n  interface DriveIO {}\n}\n",
    );
    expect(s.map((x) => `${x.kind}:${x.name}${x.parent ? `@${x.parent}` : ""}`)).toEqual([
      "class:Drive",
      "field:m_a@Drive",
      "field:m_b@Drive",
      "constructor:Drive@Drive",
      "method:periodic@Drive",
      "interface:DriveIO@Drive",
    ]);
    expect(s[0]!.bases).toEqual(["SubsystemBase", "Sendable"]);
  });

  test("C++", async () => {
    const s = await outline(
      "cpp",
      "namespace frc {\nclass Robot : public TimedRobot {\n public:\n  void TeleopPeriodic() override;\n  int m_x;\n};\n}\nvoid frc::Robot::TeleopPeriodic() {}\nint helper() { return 1; }\n",
    );
    expect(s.map((x) => `${x.kind}:${x.name}`)).toEqual([
      "namespace:frc",
      "class:Robot",
      "method:TeleopPeriodic",
      "field:m_x",
      "method:frc::Robot::TeleopPeriodic",
      "function:helper",
    ]);
    expect(s[1]!.bases).toEqual(["TimedRobot"]);
  });

  test("Python", async () => {
    const s = await outline(
      "python",
      "class MyRobot(wpilib.TimedRobot):\n    def robotInit(self):\n        pass\n\ndef helper():\n    pass\n",
    );
    expect(renderOutline(s)).toBe(
      "class MyRobot : wpilib.TimedRobot  (lines 1-3)\n  method robotInit  (lines 2-3)\nfunction helper  (lines 5-6)",
    );
  });
});
