import { spawn } from "node:child_process";
import path from "node:path";

export type Severity = "error" | "warning" | "note";

/** One problem from a build, test run or traceback, in a tool-neutral form. */
export interface Diagnostic {
  file: string | null;
  line: number | null;
  col: number | null;
  severity: Severity;
  message: string;
  tool: "javac" | "gradle" | "gcc" | "msvc" | "python" | "pytest";
  /** Source line and caret, when the tool printed them. */
  context?: string;
}

/** Makes absolute paths inside the project relative to it, with forward slashes. */
function projectPath(file: string, projectDir?: string): string {
  const normalized = file.replace(/\\/g, "/");
  if (!projectDir) return normalized;
  const root = projectDir.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

const JAVAC = /^\s*(.+\.java):(\d+): (error|warning): (.+)$/;
const GCC = /^(.+?\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inc)):(\d+):(\d+): (fatal error|error|warning|note): (.+)$/;
const MSVC = /^(.+?\.(?:c|cc|cpp|cxx|h|hpp))\((\d+)(?:,(\d+))?\): (fatal error|error|warning) ([A-Z]+\d+): (.+)$/;
const PY_FRAME = /^\s*File "(.+)", line (\d+), in (.+)$/;
const PYTEST_LOCATION = /^(.+\.py):(\d+): (\w+)$/;
const PYTEST_SUMMARY = /^FAILED (.+?)::(\S+)(?: - (.+))?$/;

/** Parses javac, Gradle, gcc/clang, MSVC, Python and pytest output into diagnostics. */
export function parseBuildOutput(output: string, projectDir?: string): Diagnostic[] {
  const lines = output.split(/\r?\n/);
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();
  const add = (d: Diagnostic) => {
    const key = `${d.tool}|${d.file}|${d.line}|${d.col}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diags.push(d);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = JAVAC.exec(line))) {
      // javac prints the source line, then a caret line under the column.
      const src = lines[i + 1];
      const caret = lines[i + 2];
      const caretCol = caret && /^\s*\^\s*$/.test(caret) ? caret.indexOf("^") - leadingIndent(line) + 1 : null;
      add({
        file: projectPath(m[1]!.trim(), projectDir),
        line: Number(m[2]),
        col: caretCol && caretCol > 0 ? caretCol : null,
        severity: m[3] as Severity,
        message: m[4]!,
        tool: "javac",
        ...(src !== undefined && caretCol ? { context: `${src.trimEnd()}\n${caret!.trimEnd()}` } : {}),
      });
    } else if ((m = GCC.exec(line))) {
      add({
        file: projectPath(m[1]!, projectDir),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4] === "note" ? "note" : m[4] === "warning" ? "warning" : "error",
        message: m[5]!,
        tool: "gcc",
      });
    } else if ((m = MSVC.exec(line))) {
      add({
        file: projectPath(m[1]!, projectDir),
        line: Number(m[2]),
        col: m[3] ? Number(m[3]) : null,
        severity: m[4] === "warning" ? "warning" : "error",
        message: `${m[5]}: ${m[6]}`,
        tool: "msvc",
      });
    } else if (line.startsWith("Traceback (most recent call last):")) {
      i = parseTraceback(lines, i, projectDir, add);
    } else if ((m = PYTEST_SUMMARY.exec(line))) {
      add({
        file: projectPath(m[1]!, projectDir),
        line: null,
        col: null,
        severity: "error",
        message: `${m[2]} failed${m[3] ? `: ${m[3]}` : ""}`,
        tool: "pytest",
      });
    } else if (
      (m = PYTEST_LOCATION.exec(line)) &&
      lines.slice(Math.max(0, i - 15), i).some((l) => l.startsWith("E "))
    ) {
      const errors = lines
        .slice(Math.max(0, i - 15), i)
        .filter((l) => l.startsWith("E "))
        .map((l) => l.slice(2).trim());
      add({
        file: projectPath(m[1]!, projectDir),
        line: Number(m[2]),
        col: null,
        severity: "error",
        message: errors.join(" / ") || m[3]!,
        tool: "pytest",
      });
    } else if (line.trim() === "* What went wrong:") {
      i = parseGradleFailure(lines, i, add);
    }
  }
  return diags;
}

function leadingIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function parseTraceback(
  lines: string[],
  start: number,
  projectDir: string | undefined,
  add: (d: Diagnostic) => void,
): number {
  let frame: { file: string; line: number } | null = null;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    const f = PY_FRAME.exec(l);
    if (f) {
      frame = { file: f[1]!, line: Number(f[2]) };
      continue;
    }
    if (/^\s/.test(l) || l === "") continue;
    // First unindented line after the frames is "ExceptionType: message".
    add({
      file: frame ? projectPath(frame.file, projectDir) : null,
      line: frame?.line ?? null,
      col: null,
      severity: "error",
      message: l.trim(),
      tool: "python",
    });
    break;
  }
  return i;
}

function parseGradleFailure(lines: string[], start: number, add: (d: Diagnostic) => void): number {
  const body: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("* ") || /^BUILD (FAILED|SUCCESSFUL)/.test(l)) break;
    if (l.trim()) body.push(l.trim().replace(/^> /, ""));
  }
  // "Compilation failed; see the compiler output below." repeats javac errors we already have.
  const message = body
    .filter((l) => !JAVAC.test(l) && !/^(\^|\s*$)/.test(l))
    .slice(0, 6)
    .join("\n");
  if (message) add({ file: null, line: null, col: null, severity: "error", message, tool: "gradle" });
  return i - 1;
}

export interface BuildRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  diagnostics: Diagnostic[];
  command: string;
}

export interface RunBuildOptions {
  projectDir: string;
  /** Gradle task (`build`, `test`) or, for Python, `test`. */
  task: "build" | "test";
  language: "java" | "cpp" | "python";
  /** JDK home for Gradle projects. */
  javaHome?: string;
  /** Python with robotpy installed, for Python projects. */
  python?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Output beyond this is dropped from the middle (the start and the end carry the useful parts). */
const OUTPUT_CAP = 400_000;

/** Runs gradlew (with the resolved JDK and a plain console) or robotpy, and parses the output. */
export function runBuild(opts: RunBuildOptions): Promise<BuildRun> {
  const isWindows = process.platform === "win32";
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  let cmd: string;
  let args: string[];
  if (opts.language === "python") {
    cmd = opts.python ?? (isWindows ? "py" : "python3");
    const pre = cmd === "py" ? ["-3"] : [];
    // Python has no build step; byte-compiling catches syntax errors.
    args =
      opts.task === "test"
        ? [...pre, "-m", "robotpy", "test"]
        : [...pre, "-m", "compileall", "-q", "-x", "[\\\\/](\\.venv|venv|build)[\\\\/]", "."];
  } else {
    cmd = isWindows ? "gradlew.bat" : "./gradlew";
    // The rich console is for humans; plain output is what the parsers expect.
    args = [opts.task, "--console=plain"];
    if (opts.javaHome) {
      env["JAVA_HOME"] = opts.javaHome;
      env["PATH"] = `${path.join(opts.javaHome, "bin")}${path.delimiter}${env["PATH"] ?? ""}`;
    }
  }
  const command = [cmd, ...args].join(" ");
  return new Promise((resolve) => {
    const child =
      isWindows && cmd.endsWith(".bat")
        ? spawn(command, { cwd: opts.projectDir, env, shell: true })
        : spawn(cmd, args, { cwd: opts.projectDir, env });
    let output = "";
    let timedOut = false;
    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      opts.onOutput?.(s);
      output += s;
      if (output.length > OUTPUT_CAP)
        output = `${output.slice(0, OUTPUT_CAP / 4)}\n…\n${output.slice(-OUTPUT_CAP / 2)}`;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => child.kill();
    const timer = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      opts.timeoutMs ?? 10 * 60_000,
    );
    opts.signal?.addEventListener("abort", kill, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({
        ok: exitCode === 0,
        exitCode,
        timedOut,
        output,
        diagnostics: parseBuildOutput(output, opts.projectDir),
        command,
      });
    };
    child.on("error", (err) => {
      output += `\n${err.message}\n`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
