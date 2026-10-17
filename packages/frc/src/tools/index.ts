import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ToolDefinition, Workspace } from "@codecoach/core";
import { ToolError, WorkspaceError, defineTool } from "@codecoach/core";

import { analyzeProject, renderProjectSummary } from "../analyzer.js";
import type { ProjectSummary } from "../analyzer.js";
import { runBuild } from "../build.js";
import type { Diagnostic } from "../build.js";
import { requiredJdk, resolveJdk } from "../jdk.js";
import type { JdkResolution } from "../jdk.js";
import { languageForFile, outline, renderOutline } from "../outline.js";
import { mapRobotStructure, renderStructure } from "../structure.js";

export interface FrcToolOptions {
  /** Called when the coach proposes a diff at L3; the UI shows it for review. */
  onProposedDiff?: (proposal: { file: string; summary: string; diff: string }) => void;
  /** Overrides the Python used for RobotPy projects. */
  python?: string;
}

/** Workspace errors become tool errors the model can act on. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkspaceError) throw new ToolError(err.message);
    throw err;
  }
}

function numbered(text: string, start: number): string {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join("\n");
}

export function renderDiagnostics(diags: readonly Diagnostic[], max = 30): string {
  if (!diags.length) return "No diagnostics were parsed from the output.";
  const shown = diags.slice(0, max).map((d) => {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}${d.col ? `:${d.col}` : ""}` : "(build)";
    return `- [${d.tool} ${d.severity}] ${where}: ${d.message}${d.context ? `\n${d.context.replace(/^/gm, "    ")}` : ""}`;
  });
  if (diags.length > max) shown.push(`…and ${diags.length - max} more.`);
  return shown.join("\n");
}

export function renderJdkResolution(r: JdkResolution): string {
  const lines = [`Required: Java ${r.required}, because ${r.reason}.`];
  if (r.conflict) lines.push(`Note: ${r.conflict}.`);
  if (r.chosen) lines.push(`Chosen: Java ${r.chosen.version} from ${r.chosen.source} (${r.chosen.home}).`);
  for (const c of r.rejected)
    lines.push(`Skipped ${c.source}${c.home ? ` (${c.home})` : ""}: ${c.major ? `Java ${c.major}` : "no JDK found"}.`);
  if (r.diagnostic) lines.push(`Problem (${r.diagnostic.code}): ${r.diagnostic.message}`);
  return lines.join("\n");
}

/** The read-only FRC tools, plus run_build/run_tests and the L3-only propose_diff. */
export function frcTools(opts: FrcToolOptions = {}): ToolDefinition[] {
  // One analysis per project root for the life of this tool set.
  const summaries = new Map<string, Promise<ProjectSummary>>();
  const projectSummary = (ws: Workspace) => {
    let s = summaries.get(ws.root);
    if (!s) summaries.set(ws.root, (s = analyzeProject(ws)));
    return s;
  };
  let buildConfirmed = false;

  const listFiles = defineTool({
    name: "list_files",
    description:
      'List files in the student\'s robot project. Paths are relative to the project root. Use a glob like "*.java" or "src/main/java/**" to narrow it down.',
    input: z.object({
      dir: z.string().default(".").describe("Folder to list, relative to the project root."),
      glob: z.string().optional().describe("Only list files matching this glob."),
    }),
    readOnly: true,
    run: ({ dir, glob }, ctx) =>
      guarded(async () => {
        const { files, truncated } = await ctx.workspace.listFiles(dir, { ...(glob ? { glob } : {}), max: 400 });
        if (!files.length) return "No files found.";
        return files.join("\n") + (truncated ? "\n(More files not shown; narrow the glob.)" : "");
      }),
  });

  const readFile = defineTool({
    name: "read_file",
    description:
      "Read a file from the project, with line numbers. Read a line range for large files. Some paths (build output, .env files, keys, .codecoach/) are off limits.",
    input: z.object({
      path: z.string().describe("File path relative to the project root."),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    }),
    readOnly: true,
    run: (input, ctx) =>
      guarded(async () => {
        const r = await ctx.workspace.readFile(input.path, {
          ...(input.start_line ? { startLine: input.start_line } : {}),
          ...(input.end_line ? { endLine: input.end_line } : {}),
        });
        const header = `${r.path} (lines ${r.startLine}-${r.endLine} of ${r.totalLines})`;
        return `${header}\n${numbered(r.text, r.startLine)}${r.truncated ? "\n(Truncated at 200 KB; read a smaller range.)" : ""}`;
      }),
  });

  const grep = defineTool({
    name: "grep",
    description:
      "Search project files with a JavaScript regular expression. Returns matching lines with file and line number.",
    input: z.object({
      pattern: z.string().describe("JavaScript regular expression."),
      glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.java".'),
      ignore_case: z.boolean().default(false),
    }),
    readOnly: true,
    run: ({ pattern, glob, ignore_case }, ctx) =>
      guarded(async () => {
        const { matches, truncated } = await ctx.workspace.grep(pattern, {
          ...(glob ? { glob } : {}),
          ignoreCase: ignore_case,
          max: 100,
        });
        if (!matches.length) return "No matches.";
        return (
          matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") +
          (truncated ? "\n(More matches not shown.)" : "")
        );
      }),
  });

  const outlineSymbols = defineTool({
    name: "outline_symbols",
    description: "Outline the classes, methods and fields in a Java, C++ or Python file, with line ranges.",
    input: z.object({ path: z.string() }),
    readOnly: true,
    run: ({ path: file }, ctx) =>
      guarded(async () => {
        const lang = languageForFile(file);
        if (!lang) throw new ToolError(`outline_symbols supports .java, C++ and .py files, not "${file}".`);
        const r = await ctx.workspace.readFile(file);
        const symbols = await outline(lang, r.text);
        return symbols.length ? `${r.path}\n${renderOutline(symbols)}` : `${r.path}: no symbols found.`;
      }),
  });

  const mapStructure = defineTool({
    name: "map_robot_structure",
    description:
      "Map the robot code: robot class, subsystems (and whether each has a default command), command classes, setDefaultCommand calls, trigger bindings, addRequirements calls and CommandScheduler.run().",
    input: z.object({}),
    readOnly: true,
    run: (_input, ctx) => guarded(async () => renderStructure(await mapRobotStructure(ctx.workspace))),
  });

  const analyze = defineTool({
    name: "analyze_project",
    description:
      "Summarize the project: language, WPILib season, controller (roboRIO or SystemCore), GradleRIO version, Java level, vendor libraries and code pattern.",
    input: z.object({}),
    readOnly: true,
    run: (_input, ctx) => guarded(async () => renderProjectSummary(await projectSummary(ctx.workspace))),
  });

  const jdk = defineTool({
    name: "resolve_jdk",
    description:
      "Work out which Java version this project needs (17 for roboRIO, 25 for SystemCore) and which installed JDK matches.",
    input: z.object({}),
    readOnly: true,
    run: (_input, ctx) =>
      guarded(async () => {
        const s = await projectSummary(ctx.workspace);
        const req = requiredJdk({
          controller: s.controller?.value ?? null,
          toolchainVersion: s.toolchainVersion?.value ?? null,
        });
        return renderJdkResolution(resolveJdk(req, s.wpilibYear?.value ?? null));
      }),
  });

  const build = (task: "build" | "test") =>
    defineTool({
      name: task === "build" ? "run_build" : "run_tests",
      description:
        task === "build"
          ? "Build the project (gradlew build with the right JDK, or a syntax check for Python) and return parsed errors. The student is asked to allow the first run."
          : "Run the project's unit tests (gradlew test, or robotpy test) and return parsed failures. The student is asked to allow the first run.",
      input: z.object({}),
      readOnly: false,
      run: async (_input, ctx) => {
        if (!buildConfirmed) {
          const ok = await ctx.confirm(
            `CodeCoach wants to run ${task === "build" ? "a build" : "the tests"} of your project. Allow builds for this session?`,
          );
          if (!ok)
            throw new ToolError(
              "The student declined to run the build. Ask them to run it and paste the errors instead.",
            );
          buildConfirmed = true;
        }
        const s = await projectSummary(ctx.workspace);
        const language = s.language?.value ?? "java";
        let javaHome: string | undefined;
        if (language !== "python") {
          const req = requiredJdk({
            controller: s.controller?.value ?? null,
            toolchainVersion: s.toolchainVersion?.value ?? null,
          });
          const r = resolveJdk(req, s.wpilibYear?.value ?? null);
          if (!r.chosen) return `Did not run the build.\n${renderJdkResolution(r)}`;
          javaHome = r.chosen.home;
        }
        const venvPython = path.join(
          ctx.workspace.root,
          ".venv",
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        );
        const python =
          opts.python ?? process.env["CODECOACH_PYTHON"] ?? (existsSync(venvPython) ? venvPython : undefined);
        const extraLib = process.env["CODECOACH_PYTHON_LIBRARY_PATH"];
        const result = await runBuild({
          projectDir: ctx.workspace.root,
          task,
          language,
          ...(javaHome ? { javaHome } : {}),
          ...(python ? { python } : {}),
          signal: ctx.signal,
          ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
          ...(language === "python" && extraLib && process.platform === "linux"
            ? {
                env: {
                  LD_LIBRARY_PATH: [extraLib, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(path.delimiter),
                },
              }
            : {}),
        });
        const status = result.timedOut
          ? "timed out"
          : result.ok
            ? "succeeded"
            : `failed (exit code ${result.exitCode})`;
        const tail = result.ok
          ? ""
          : `\nLast lines of output:\n${result.output.trim().split(/\r?\n/).slice(-15).join("\n")}`;
        return `\`${result.command}\` ${status}.\n${renderDiagnostics(result.diagnostics)}${tail}`;
      },
    });

  const proposeDiff = defineTool({
    name: "propose_diff",
    description:
      "Propose a change as a unified diff for the student to review. Nothing is written: the student reads the diff and decides whether to apply it. Only use after the student understands the problem.",
    input: z.object({
      file: z.string().describe("File the diff applies to."),
      summary: z.string().describe("One sentence on what the change does and why."),
      diff: z.string().describe("Unified diff (---/+++ headers, @@ hunks)."),
    }),
    levels: ["L3"],
    readOnly: true,
    run: (input, ctx) =>
      guarded(async () => {
        await ctx.workspace.resolve(input.file);
        if (!/^@@ /m.test(input.diff)) throw new ToolError("The diff needs at least one @@ hunk.");
        opts.onProposedDiff?.(input);
        return "The diff is shown to the student for review. They decide whether to apply it; ask what they think it changes.";
      }),
  });

  return [
    listFiles,
    readFile,
    grep,
    outlineSymbols,
    mapStructure,
    analyze,
    jdk,
    build("build"),
    build("test"),
    proposeDiff,
  ];
}
