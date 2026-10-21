import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { Workspace } from "@codecoach/core";

import { analyzeProject, mapRobotStructure, renderProjectSummary, renderStructure } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const ws = (name: string) => new Workspace(path.join(FIXTURES, name));

describe("analyzeProject", () => {
  test("roboRIO Java template", async () => {
    const s = await analyzeProject(ws("java-roborio-hello"));
    expect(s.language).toEqual({ value: "java", source: ".wpilib/wpilib_preferences.json" });
    expect(s.wpilibYear?.value).toBe("2026");
    expect(s.controller).toEqual({ value: "roborio", source: "build.gradle deploy target RoboRIO" });
    expect(s.gradleRio?.value).toEqual({ pluginId: "edu.wpi.first.GradleRIO", version: "2026.2.1" });
    expect(s.javaVersion?.value).toBe(17);
    expect(s.teamNumber?.value).toBe(0);
    expect(s.libraries).toEqual(["WPILib commands"]);
    expect(s.pattern.value).toBe("command-based");
    expect(s.warnings).toEqual([]);
  });

  test("SystemCore Java template", async () => {
    const s = await analyzeProject(ws("java-systemcore-hello"));
    expect(s.controller).toEqual({ value: "systemcore", source: "build.gradle deploy target SystemCore" });
    expect(s.gradleRio?.value.pluginId).toBe("org.wpilib.GradleRIO");
    expect(s.javaVersion?.value).toBe(25);
    expect(s.wpilibYear?.value).toBe("2027_alpha7");
    expect(s.libraries).toEqual(["WPILib commands"]);
  });

  test("RobotPy project", async () => {
    const s = await analyzeProject(ws("python-hello"));
    expect(s.language?.value).toBe("python");
    expect(s.robotpy?.value).toEqual({ version: "2026.2.2", components: [], requires: [] });
    expect(s.controller?.value).toBe("roborio");
    expect(s.pattern.value).toBe("timed");
  });

  test("flags vendordeps from another season", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vd-"));
    cpSync(path.join(FIXTURES, "java-roborio-hello"), dir, {
      recursive: true,
      filter: (p) => !/[\\/](build|\.gradle)([\\/]|$)/.test(p),
    });
    writeFileSync(
      path.join(dir, "vendordeps/REVLib.json"),
      JSON.stringify({ name: "REVLib", version: "2025.0.3", frcYear: "2025", uuid: "x" }),
    );
    const s = await analyzeProject(new Workspace(dir));
    expect(s.libraries).toContain("REVLib");
    expect(s.warnings).toEqual(["vendordeps/REVLib.json is for 2025 but the project is 2026"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("renders the same text for the same project (cache-stable)", async () => {
    const a = renderProjectSummary(await analyzeProject(ws("java-roborio-hello")));
    const b = renderProjectSummary(await analyzeProject(ws("java-roborio-hello")));
    expect(a).toBe(b);
    expect(a).toContain("Controller: roborio (from build.gradle deploy target RoboRIO)");
  });
});

describe("mapRobotStructure", () => {
  test("finds subsystems, commands and bindings in the command template", async () => {
    const s = await mapRobotStructure(ws("java-roborio-hello"));
    expect(s.language).toBe("java");
    expect(s.robotClass).toMatchObject({ name: "Robot", base: "TimedRobot" });
    expect(s.subsystems).toEqual([
      expect.objectContaining({
        name: "ExampleSubsystem",
        instances: ["m_exampleSubsystem", "m_subsystem"],
        hasDefaultCommand: false,
      }),
    ]);
    expect(s.commands.map((c) => c.name)).toEqual(["ExampleCommand"]);
    expect(s.bindings.map((b) => b.method).sort()).toEqual(["onTrue", "whileTrue"]);
    expect(s.requirements).toEqual([expect.objectContaining({ inClass: "ExampleCommand", args: "subsystem" })]);
    expect(s.schedulerRun).toEqual([expect.objectContaining({ file: "src/main/java/frc/robot/Robot.java" })]);
    expect(renderStructure(s)).toContain("default command: NONE");
  });

  test("notices a default command once one is set", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dc-"));
    cpSync(path.join(FIXTURES, "java-roborio-hello/src"), path.join(dir, "src"), { recursive: true });
    const file = path.join(dir, "src/main/java/frc/robot/RobotContainer.java");
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(file, "utf8").replace(
      "configureBindings();",
      "configureBindings();\n    m_exampleSubsystem.setDefaultCommand(new ExampleCommand(m_exampleSubsystem));",
    );
    writeFileSync(file, text);
    const s = await mapRobotStructure(new Workspace(dir));
    expect(s.subsystems[0]!.hasDefaultCommand).toBe(true);
    expect(s.defaultCommands[0]).toMatchObject({
      subsystem: "m_exampleSubsystem (ExampleSubsystem)",
      command: "new ExampleCommand(m_exampleSubsystem)",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("Python robots", async () => {
    const s = await mapRobotStructure(ws("python-hello"));
    expect(s.language).toBe("python");
    expect(s.robotClass).toMatchObject({ name: "MyRobot", base: "TimedRobot" });
  });
});
