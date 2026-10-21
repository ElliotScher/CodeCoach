import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { ToolRegistry, Workspace } from "@codecoach/core";
import type { ToolCall } from "@codecoach/core";

import { frcTools } from "../src/index.js";

const root = fileURLToPath(new URL("../../../fixtures/java-roborio-hello", import.meta.url));
const ctx = (confirm: (q: string) => Promise<boolean> = async () => false) => ({
  workspace: new Workspace(root),
  confirm,
  signal: new AbortController().signal,
});
const call = (name: string, input: unknown = {}): ToolCall => ({ id: name, name, input });

describe("frc tools", () => {
  const registry = new ToolRegistry(frcTools());

  test("propose_diff is only registered at L3", () => {
    expect(registry.specs("L0").map((s) => s.name)).toEqual([
      "analyze_project",
      "grep",
      "list_files",
      "map_robot_structure",
      "outline_symbols",
      "read_file",
      "resolve_jdk",
      "run_build",
      "run_tests",
    ]);
    expect(registry.specs("L3").map((s) => s.name)).toContain("propose_diff");
  });

  test("tool schemas are plain JSON schema objects", () => {
    const read = registry.specs("L0").find((s) => s.name === "read_file")!;
    expect(read.inputSchema).toMatchObject({ type: "object", required: ["path"] });
  });

  test("read_file numbers lines", async () => {
    const r = await registry.execute(
      call("read_file", { path: "src/main/java/frc/robot/Main.java", start_line: 1, end_line: 2 }),
      "L0",
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(r.content.split("\n").slice(0, 3)).toEqual([
      "src/main/java/frc/robot/Main.java (lines 1-2 of 26)",
      expect.stringMatching(/^1\| \/\/ Copyright/),
      expect.stringMatching(/^2\| /),
    ]);
  });

  test("sandbox refusals come back as tool errors", async () => {
    const r = await registry.execute(call("read_file", { path: "../../package.json" }), "L0", ctx());
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/outside the project folder/) });
  });

  test("run_build asks first and respects a no", async () => {
    const questions: string[] = [];
    const r = await registry.execute(
      call("run_build"),
      "L0",
      ctx(async (q: string) => (questions.push(q), false)),
    );
    expect(questions).toHaveLength(1);
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/declined/) });
  });

  test("map_robot_structure and analyze_project render text", async () => {
    const [structure, project] = await registry.executeAll(
      [call("map_robot_structure"), call("analyze_project")],
      "L0",
      ctx(),
    );
    expect(structure!.content).toContain("ExampleSubsystem");
    expect(project!.content).toContain("Controller: roborio");
  });

  test("outline_symbols rejects unsupported files", async () => {
    const r = await registry.execute(call("outline_symbols", { path: "build.gradle" }), "L0", ctx());
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/supports/) });
  });

  test("propose_diff needs a hunk and reports the proposal", async () => {
    const proposals: unknown[] = [];
    const reg = new ToolRegistry(frcTools({ onProposedDiff: (p) => proposals.push(p) }));
    const file = path.posix.join("src/main/java/frc/robot", "Robot.java");
    const bad = await reg.execute(call("propose_diff", { file, summary: "x", diff: "nothing" }), "L3", ctx());
    expect(bad.isError).toBe(true);
    const good = await reg.execute(
      call("propose_diff", { file, summary: "x", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n" }),
      "L3",
      ctx(),
    );
    expect(good.isError).toBe(false);
    expect(proposals).toHaveLength(1);
  });
});
