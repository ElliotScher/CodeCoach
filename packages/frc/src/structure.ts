import type { Node } from "web-tree-sitter";

import type { Workspace } from "@codecoach/core";

import { languageForFile, parseSource } from "./outline.js";
import type { SourceLanguage } from "./outline.js";

export interface Located {
  file: string;
  line: number;
}

export interface SubsystemInfo extends Located {
  name: string;
  /** Variables in other classes that hold an instance of this subsystem. */
  instances: string[];
  hasDefaultCommand: boolean;
}

export interface RobotStructure {
  language: SourceLanguage | null;
  robotClass: (Located & { name: string; base: string }) | null;
  subsystems: SubsystemInfo[];
  commands: (Located & { name: string; base: string })[];
  defaultCommands: (Located & { subsystem: string; command: string })[];
  bindings: (Located & { trigger: string; method: string; command: string })[];
  requirements: (Located & { inClass: string; args: string })[];
  schedulerRun: Located[];
  advantageKit: { loggerStart: Located[]; ioInterfaces: string[] };
  filesScanned: number;
  truncated: boolean;
}

const ROBOT_BASES = new Set([
  "TimedRobot",
  "LoggedRobot",
  "TimesliceRobot",
  "RobotBase",
  "IterativeRobotBase",
  "TimedCommandRobot",
]);
const SUBSYSTEM_BASES = new Set(["SubsystemBase", "Subsystem"]);
const COMMAND_BASES =
  /^(Command|CommandBase|InstantCommand|RunCommand|FunctionalCommand|StartEndCommand|SequentialCommandGroup|ParallelCommandGroup|ParallelRaceGroup|ParallelDeadlineGroup|PIDCommand|ProfiledPIDCommand|TrapezoidProfileCommand|WaitCommand)$/;
const BINDING_METHODS = new Set([
  "onTrue",
  "onFalse",
  "whileTrue",
  "whileFalse",
  "toggleOnTrue",
  "toggleOnFalse",
  "onChange",
]);
const MAX_FILES = 400;

const simpleName = (s: string) => s.replace(/<.*$/, "").split(".").at(-1)!.trim();
const at = (file: string, node: Node): Located => ({ file, line: node.startPosition.row + 1 });
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Maps subsystems, commands, default commands and trigger bindings across the project. */
export async function mapRobotStructure(ws: Workspace): Promise<RobotStructure> {
  const { files, truncated: listTruncated } = await ws.listFiles(".", {
    glob: "**/*.{java,py,cpp,h,hpp}",
    max: MAX_FILES,
  });
  const s: RobotStructure = {
    language: null,
    robotClass: null,
    subsystems: [],
    commands: [],
    defaultCommands: [],
    bindings: [],
    requirements: [],
    schedulerRun: [],
    advantageKit: { loggerStart: [], ioInterfaces: [] },
    filesScanned: 0,
    truncated: listTruncated,
  };
  const counts: Partial<Record<SourceLanguage, number>> = {};
  /** variable name → class name, from field and local declarations. */
  const varTypes = new Map<string, string>();
  const ownDefaults = new Set<string>();

  for (const file of files) {
    const lang = languageForFile(file);
    if (!lang || lang === "cpp") continue; // C++ structure mapping arrives with stage 5.
    let text: string;
    try {
      text = (await ws.readFile(file)).text;
    } catch {
      continue;
    }
    counts[lang] = (counts[lang] ?? 0) + 1;
    s.filesScanned++;
    const tree = await parseSource(lang, text);
    try {
      if (lang === "java") scanJava(file, tree.rootNode, s, varTypes, ownDefaults);
      else scanPython(file, tree.rootNode, s, varTypes, ownDefaults);
    } finally {
      tree.delete();
    }
  }

  s.language = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as SourceLanguage | undefined) ?? null;
  for (const sub of s.subsystems) {
    sub.instances = [...varTypes]
      .filter(([, type]) => type === sub.name)
      .map(([v]) => v)
      .sort();
    sub.hasDefaultCommand =
      ownDefaults.has(sub.name) ||
      s.defaultCommands.some((d) => d.subsystem === sub.name || sub.instances.includes(d.subsystem));
  }
  // Report default commands against the subsystem class where we can tell.
  for (const d of s.defaultCommands) {
    const type = varTypes.get(d.subsystem);
    if (type && s.subsystems.some((sub) => sub.name === type)) d.subsystem = `${d.subsystem} (${type})`;
  }
  return s;
}

function enclosingClass(node: Node): string | null {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    if (n.type === "class_declaration" || n.type === "class_definition")
      return n.childForFieldName("name")?.text ?? null;
  }
  return null;
}

function scanJava(
  file: string,
  root: Node,
  s: RobotStructure,
  varTypes: Map<string, string>,
  ownDefaults: Set<string>,
): void {
  for (const cls of root.descendantsOfType(["class_declaration", "interface_declaration"])) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text;
    if (!name) continue;
    if (cls.type === "interface_declaration") {
      if (/IO$/.test(name)) s.advantageKit.ioInterfaces.push(name);
      continue;
    }
    const superclass = cls.childForFieldName("superclass")?.text.replace(/^extends\s+/, "") ?? "";
    const interfaces = (cls.childForFieldName("interfaces")?.descendantsOfType("type_identifier") ?? []).map(
      (t) => t!.text,
    );
    const bases = [superclass, ...interfaces].filter(Boolean).map(simpleName);
    const base = bases[0] ?? "";
    if (bases.some((b) => ROBOT_BASES.has(b))) s.robotClass = { name, base, ...at(file, cls) };
    else if (bases.some((b) => SUBSYSTEM_BASES.has(b)))
      s.subsystems.push({ name, instances: [], hasDefaultCommand: false, ...at(file, cls) });
    else if (bases.some((b) => COMMAND_BASES.test(b))) s.commands.push({ name, base, ...at(file, cls) });
  }

  for (const decl of root.descendantsOfType(["field_declaration", "local_variable_declaration"])) {
    const type = decl?.childForFieldName("type")?.text;
    if (!decl || !type) continue;
    for (const v of decl.descendantsOfType("variable_declarator")) {
      const varName = v?.childForFieldName("name")?.text;
      if (varName) varTypes.set(varName, simpleName(type));
    }
  }

  for (const call of root.descendantsOfType("method_invocation")) {
    if (!call) continue;
    const method = call.childForFieldName("name")?.text;
    const receiver = call.childForFieldName("object")?.text ?? null;
    const args = squash(call.childForFieldName("arguments")?.text.slice(1, -1) ?? "");
    if (method === "setDefaultCommand") {
      if (receiver === null || receiver === "this") {
        const cls = enclosingClass(call);
        if (cls) ownDefaults.add(cls);
        s.defaultCommands.push({ subsystem: cls ?? "this", command: args, ...at(file, call) });
      } else {
        s.defaultCommands.push({ subsystem: receiver, command: args, ...at(file, call) });
      }
    } else if (method && BINDING_METHODS.has(method) && receiver) {
      s.bindings.push({ trigger: squash(receiver), method, command: args, ...at(file, call) });
    } else if (method === "addRequirements") {
      s.requirements.push({ inClass: enclosingClass(call) ?? "?", args, ...at(file, call) });
    } else if (method === "run" && receiver && /CommandScheduler\.getInstance\(\)$/.test(receiver.replace(/\s/g, ""))) {
      s.schedulerRun.push(at(file, call));
    } else if (method === "start" && receiver === "Logger") {
      s.advantageKit.loggerStart.push(at(file, call));
    }
  }
}

function scanPython(
  file: string,
  root: Node,
  s: RobotStructure,
  varTypes: Map<string, string>,
  ownDefaults: Set<string>,
): void {
  for (const cls of root.descendantsOfType("class_definition")) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text;
    if (!name) continue;
    const bases = (cls.childForFieldName("superclasses")?.namedChildren ?? [])
      .filter(Boolean)
      .map((b) => simpleName(b!.text));
    const base = bases[0] ?? "";
    if (bases.some((b) => ROBOT_BASES.has(b))) s.robotClass = { name, base, ...at(file, cls) };
    else if (bases.some((b) => SUBSYSTEM_BASES.has(b)))
      s.subsystems.push({ name, instances: [], hasDefaultCommand: false, ...at(file, cls) });
    else if (bases.some((b) => COMMAND_BASES.test(b))) s.commands.push({ name, base, ...at(file, cls) });
  }
  // self.drive = DriveSubsystem()
  for (const assign of root.descendantsOfType("assignment")) {
    const left = assign?.childForFieldName("left")?.text;
    const right = assign?.childForFieldName("right");
    if (left && right?.type === "call") {
      const fn = right.childForFieldName("function")?.text;
      if (fn) varTypes.set(left, simpleName(fn));
    }
  }
  for (const call of root.descendantsOfType("call")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "attribute") continue;
    const method = fn.childForFieldName("attribute")?.text;
    const receiver = fn.childForFieldName("object")?.text ?? "";
    const args = squash(call.childForFieldName("arguments")?.text.slice(1, -1) ?? "");
    if (method === "setDefaultCommand") {
      if (receiver === "self") {
        const cls = enclosingClass(call);
        if (cls) ownDefaults.add(cls);
      }
      s.defaultCommands.push({ subsystem: receiver, command: args, ...at(file, call) });
    } else if (method && BINDING_METHODS.has(method)) {
      s.bindings.push({ trigger: squash(receiver), method, command: args, ...at(file, call) });
    } else if (method === "addRequirements") {
      s.requirements.push({ inClass: enclosingClass(call) ?? "?", args, ...at(file, call) });
    } else if (method === "run" && /CommandScheduler\.getInstance\(\)$/.test(receiver.replace(/\s/g, ""))) {
      s.schedulerRun.push(at(file, call));
    }
  }
}

/** Stable, compact text for the model. */
export function renderStructure(s: RobotStructure): string {
  const lines: string[] = [];
  lines.push(
    `Robot class: ${s.robotClass ? `${s.robotClass.name} extends ${s.robotClass.base} (${s.robotClass.file}:${s.robotClass.line})` : "not found"}`,
  );
  lines.push(`Subsystems (${s.subsystems.length}):`);
  for (const sub of s.subsystems) {
    lines.push(
      `  ${sub.name} (${sub.file}:${sub.line}) instances: ${sub.instances.join(", ") || "none found"}; default command: ${sub.hasDefaultCommand ? "yes" : "NONE"}`,
    );
  }
  lines.push(
    `Command classes (${s.commands.length}): ${s.commands.map((c) => `${c.name} extends ${c.base}`).join(", ") || "none"}`,
  );
  lines.push(`setDefaultCommand calls (${s.defaultCommands.length}):`);
  for (const d of s.defaultCommands) lines.push(`  ${d.subsystem} <- ${d.command} (${d.file}:${d.line})`);
  lines.push(`Trigger bindings (${s.bindings.length}):`);
  for (const b of s.bindings) lines.push(`  ${b.trigger}.${b.method}(${b.command}) (${b.file}:${b.line})`);
  lines.push(`addRequirements calls (${s.requirements.length}):`);
  for (const r of s.requirements) lines.push(`  in ${r.inClass}: ${r.args} (${r.file}:${r.line})`);
  lines.push(
    `CommandScheduler.getInstance().run(): ${s.schedulerRun.map((r) => `${r.file}:${r.line}`).join(", ") || "NOT FOUND"}`,
  );
  if (s.advantageKit.loggerStart.length || s.advantageKit.ioInterfaces.length) {
    lines.push(
      `AdvantageKit: Logger.start at ${s.advantageKit.loggerStart.map((r) => `${r.file}:${r.line}`).join(", ") || "none"}; IO interfaces: ${s.advantageKit.ioInterfaces.join(", ") || "none"}`,
    );
  }
  if (s.truncated) lines.push(`(Only the first ${MAX_FILES} source files were scanned.)`);
  return lines.join("\n");
}
