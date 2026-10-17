import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type { Workspace } from "@codecoach/core";

import type { Controller } from "./jdk.js";
import { mapRobotStructure } from "./structure.js";
import type { RobotStructure } from "./structure.js";

/** A detected fact and where it came from. Unknowns are null, never guessed. */
export interface Fact<T> {
  value: T;
  source: string;
}

export interface VendorDep {
  name: string;
  version: string;
  frcYear: string | null;
  uuid: string | null;
  file: string;
}

export interface ProjectSummary {
  language: Fact<"java" | "cpp" | "python"> | null;
  wpilibYear: Fact<string> | null;
  controller: Fact<Controller> | null;
  gradleRio: Fact<{ pluginId: string; version: string }> | null;
  javaVersion: Fact<number> | null;
  toolchainVersion: Fact<number> | null;
  teamNumber: Fact<number> | null;
  vendordeps: VendorDep[];
  libraries: string[];
  robotpy: Fact<{ version: string | null; components: string[]; requires: string[] }> | null;
  pattern: Fact<"command-based" | "advantagekit" | "timed" | "unknown">;
  structure: RobotStructure | null;
  warnings: string[];
}

/**
 * Known vendor libraries, matched by vendordep name (and uuid where verified
 * against a real vendordep file). TODO(verify): add vendor uuids from their
 * published vendordep JSON files.
 */
const LIBRARIES: readonly { label: string; uuids: string[]; names: RegExp }[] = [
  {
    label: "WPILib commands",
    uuids: ["111e20f7-815e-48f8-9dd6-e675ce75b266"],
    names: /^(WPILib-New-Commands|Commands ?V[23])$/i,
  },
  { label: "Phoenix 6", uuids: [], names: /^(Phoenix6|CTRE-Phoenix \(v6\))/i },
  { label: "Phoenix 5", uuids: [], names: /^(Phoenix5|CTRE-Phoenix \(v5\))/i },
  { label: "REVLib", uuids: ["3f48eb8c-50fe-43a6-9cb7-44c86353c4cb"], names: /^REVLib/i },
  { label: "PathPlanner", uuids: [], names: /pathplanner/i },
  { label: "PhotonVision", uuids: [], names: /^photon/i },
  { label: "AdvantageKit", uuids: [], names: /advantagekit/i },
  { label: "ChoreoLib", uuids: [], names: /choreo/i },
];

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

export async function analyzeProject(ws: Workspace): Promise<ProjectSummary> {
  const root = ws.root;
  const warnings: string[] = [];
  const summary: ProjectSummary = {
    language: null,
    wpilibYear: null,
    controller: null,
    gradleRio: null,
    javaVersion: null,
    toolchainVersion: null,
    teamNumber: null,
    vendordeps: [],
    libraries: [],
    robotpy: null,
    pattern: { value: "unknown", source: "no robot structure found" },
    structure: null,
    warnings,
  };

  // .wpilib/wpilib_preferences.json
  const prefsFile = ".wpilib/wpilib_preferences.json";
  const prefsText = await readText(root, prefsFile);
  if (prefsText) {
    try {
      const prefs = JSON.parse(prefsText) as { projectYear?: string; currentLanguage?: string; teamNumber?: number };
      if (prefs.projectYear) summary.wpilibYear = { value: String(prefs.projectYear), source: prefsFile };
      if (prefs.currentLanguage === "java" || prefs.currentLanguage === "cpp")
        summary.language = { value: prefs.currentLanguage, source: prefsFile };
      if (typeof prefs.teamNumber === "number" && prefs.teamNumber >= 0)
        summary.teamNumber = { value: prefs.teamNumber, source: prefsFile };
    } catch {
      warnings.push(`${prefsFile} is not valid JSON`);
    }
  }

  // build.gradle / build.gradle.kts
  for (const gradleFile of ["build.gradle", "build.gradle.kts"]) {
    const gradle = await readText(root, gradleFile);
    if (!gradle) continue;
    analyzeGradle(gradle, gradleFile, summary);
    break;
  }

  // vendordeps/*.json
  const vendorDir = path.join(root, "vendordeps");
  const vendorFiles = (await fs.readdir(vendorDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const f of vendorFiles) {
    const rel = `vendordeps/${f}`;
    try {
      const v = JSON.parse((await readText(root, rel)) ?? "") as {
        name?: string;
        version?: string;
        frcYear?: string | number;
        uuid?: string;
      };
      summary.vendordeps.push({
        name: v.name ?? f.replace(/\.json$/, ""),
        version: v.version ?? "?",
        frcYear: v.frcYear !== undefined ? String(v.frcYear) : null,
        uuid: v.uuid ?? null,
        file: rel,
      });
    } catch {
      warnings.push(`${rel} is not valid JSON`);
    }
  }
  for (const lib of LIBRARIES) {
    if (summary.vendordeps.some((v) => (v.uuid && lib.uuids.includes(v.uuid)) || lib.names.test(v.name)))
      summary.libraries.push(lib.label);
  }
  const year = summary.wpilibYear?.value.slice(0, 4);
  for (const v of summary.vendordeps) {
    if (year && v.frcYear && v.frcYear.slice(0, 4) !== year) {
      warnings.push(`${v.file} is for ${v.frcYear} but the project is ${summary.wpilibYear!.value}`);
    }
  }

  // pyproject.toml ([tool.robotpy])
  const pyproject = await readText(root, "pyproject.toml");
  if (pyproject) {
    try {
      const data = parseToml(pyproject) as {
        tool?: { robotpy?: { robotpy_version?: string; components?: string[]; requires?: string[] } };
      };
      const rp = data.tool?.robotpy;
      if (rp) {
        summary.robotpy = {
          value: { version: rp.robotpy_version ?? null, components: rp.components ?? [], requires: rp.requires ?? [] },
          source: "pyproject.toml [tool.robotpy]",
        };
        summary.language = { value: "python", source: "pyproject.toml [tool.robotpy]" };
        if (rp.robotpy_version) {
          summary.wpilibYear ??= { value: rp.robotpy_version.slice(0, 4), source: "pyproject.toml robotpy_version" };
          // TODO(verify): RobotPy's SystemCore support; 2027 releases are assumed to target SystemCore.
          summary.controller ??= {
            value: Number(rp.robotpy_version.slice(0, 4)) >= 2027 ? "systemcore" : "roborio",
            source: "pyproject.toml robotpy_version",
          };
        }
      }
    } catch (err) {
      warnings.push(`pyproject.toml could not be parsed: ${(err as Error).message}`);
    }
  }
  if (!summary.language && (await readText(root, "robot.py")) !== null)
    summary.language = { value: "python", source: "robot.py" };
  if (!summary.language && (await readText(root, "build.gradle"))) {
    const cpp = await fs.stat(path.join(root, "src/main/cpp")).catch(() => null);
    summary.language = cpp ? { value: "cpp", source: "src/main/cpp" } : { value: "java", source: "build.gradle" };
  }

  // Pattern, from the structure map.
  const structure = await mapRobotStructure(ws).catch(() => null);
  summary.structure = structure;
  if (structure) {
    if (structure.advantageKit.loggerStart.length || summary.libraries.includes("AdvantageKit")) {
      summary.pattern = {
        value: "advantagekit",
        source: structure.advantageKit.loggerStart.length ? "Logger.start call" : "AdvantageKit vendordep",
      };
    } else if (
      structure.subsystems.length ||
      structure.commands.length ||
      structure.defaultCommands.length ||
      structure.bindings.length
    ) {
      summary.pattern = {
        value: "command-based",
        source: `${structure.subsystems.length} subsystem(s), ${structure.bindings.length} binding(s)`,
      };
    } else if (structure.robotClass) {
      summary.pattern = { value: "timed", source: `${structure.robotClass.name} extends ${structure.robotClass.base}` };
    }
  }
  return summary;
}

function analyzeGradle(gradle: string, file: string, summary: ProjectSummary): void {
  // plugins { id "edu.wpi.first.GradleRIO" version "2026.2.1" } (2027: org.wpilib.GradleRIO)
  const plugin =
    /id\s*\(?\s*["']((?:edu\.wpi\.first|org\.wpilib)\.GradleRIO)["']\s*\)?\s*version\s*\(?\s*["']([^"']+)["']/.exec(
      gradle,
    );
  if (plugin) summary.gradleRio = { value: { pluginId: plugin[1]!, version: plugin[2]! }, source: file };

  const compat =
    /sourceCompatibility\s*=\s*JavaVersion\.VERSION_(\d+)/.exec(gradle) ??
    /sourceCompatibility\s*=\s*['"]?(\d+)/.exec(gradle);
  if (compat) summary.javaVersion = { value: Number(compat[1]), source: `${file} sourceCompatibility` };
  const toolchain = /languageVersion(?:\.set\()?\s*=?\s*JavaLanguageVersion\.of\((\d+)\)/.exec(gradle);
  if (toolchain)
    summary.toolchainVersion = { value: Number(toolchain[1]), source: `${file} java.toolchain.languageVersion` };

  // Deploy target: getTargetTypeClass('SystemCore') vs ('RoboRIO').
  const target = /getTargetTypeClass\(\s*['"](SystemCore|RoboRIO)['"]\s*\)/.exec(gradle);
  if (target) {
    summary.controller = {
      value: target[1] === "SystemCore" ? "systemcore" : "roborio",
      source: `${file} deploy target ${target[1]}`,
    };
  } else if (plugin) {
    const major = Number(plugin[2]!.slice(0, 4));
    summary.controller = { value: major >= 2027 ? "systemcore" : "roborio", source: `${file} GradleRIO ${plugin[2]}` };
  }
  if (!summary.wpilibYear && plugin)
    summary.wpilibYear = { value: plugin[2]!.slice(0, 4), source: `${file} GradleRIO version` };
}

/** Stable rendering for prompt layer 3: fixed key order, no timestamps. */
export function renderProjectSummary(s: ProjectSummary): string {
  const f = <T>(fact: Fact<T> | null, show: (v: T) => string = String) =>
    fact ? `${show(fact.value)} (from ${fact.source})` : "unknown";
  const lines = [
    `Language: ${f(s.language)}`,
    `WPILib season: ${f(s.wpilibYear)}`,
    `Controller: ${f(s.controller)}`,
    `GradleRIO: ${f(s.gradleRio, (v) => `${v.pluginId} ${v.version}`)}`,
    `Java source level: ${f(s.javaVersion)}`,
    ...(s.toolchainVersion ? [`Java toolchain: ${f(s.toolchainVersion)}`] : []),
    `Team number: ${f(s.teamNumber)}`,
    `Vendor libraries: ${s.vendordeps.length ? s.vendordeps.map((v) => `${v.name} ${v.version}`).join(", ") : "none"}`,
    ...(s.robotpy
      ? [
          `RobotPy: ${s.robotpy.value.version ?? "?"}; components: ${s.robotpy.value.components.join(", ") || "none"}; requires: ${s.robotpy.value.requires.join(", ") || "none"}`,
        ]
      : []),
    `Code pattern: ${f(s.pattern)}`,
    ...(s.warnings.length ? [`Warnings: ${s.warnings.join("; ")}`] : []),
  ];
  return lines.join("\n");
}
