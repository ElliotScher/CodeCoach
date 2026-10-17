import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The JDK resolver. Robot code never trusts the ambient JAVA_HOME: roboRIO
 * projects need JDK 17 and SystemCore projects need JDK 25, so the JDK is
 * chosen from the project. (`scripts/lib/jdk-probe.mjs` is a dependency-free
 * copy of the lookup order for `pnpm run doctor`, which runs before install.)
 */

export type Controller = "roborio" | "systemcore";

export const CONTROLLER_JDK: Readonly<Record<Controller, number>> = { roborio: 17, systemcore: 25 };

export interface JdkRequirement {
  major: number;
  reason: string;
  /** Set when an explicit toolchain disagrees with the controller's JDK. */
  conflict?: string;
}

export function requiredJdk(project: {
  controller: Controller | null;
  toolchainVersion?: number | null;
}): JdkRequirement {
  const fromController = project.controller ? CONTROLLER_JDK[project.controller] : null;
  const toolchain = project.toolchainVersion ?? null;
  if (toolchain !== null) {
    return {
      major: toolchain,
      reason: `build.gradle sets java.toolchain.languageVersion to ${toolchain}`,
      ...(fromController !== null && fromController !== toolchain
        ? {
            conflict: `${project.controller} projects normally use JDK ${fromController}, but the toolchain asks for ${toolchain}`,
          }
        : {}),
    };
  }
  if (project.controller === "systemcore")
    return { major: 25, reason: "the project targets SystemCore, which runs Java 25" };
  if (project.controller === "roborio")
    return { major: 17, reason: "the project targets the roboRIO, which runs Java 17" };
  return { major: 17, reason: "the controller could not be detected, so the roboRIO default (Java 17) is assumed" };
}

export interface JdkCandidate {
  home: string;
  version: string | null;
  major: number | null;
  source: string;
}

export interface JdkResolution {
  required: number;
  reason: string;
  conflict?: string;
  chosen?: { home: string; version: string; source: string };
  rejected: JdkCandidate[];
  /** A student-facing explanation when no matching JDK was found. */
  diagnostic?: { code: "jdk-mismatch"; message: string };
}

export interface JdkEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  homedir?: string;
  readFile?: (p: string) => string;
  readdir?: (p: string) => string[];
  exists?: (p: string) => boolean;
  /** Runs a command, returning stdout+stderr ("" if it can't run). */
  exec?: (cmd: string, args: string[]) => string;
}

/** Major version from "17.0.20", "25", or legacy "1.8.0_292". */
export function majorFromVersion(version: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] !== undefined ? Number(m[2]) : first;
}

export function parseReleaseFile(text: string): { version: string; major: number } | null {
  const m = /^JAVA_VERSION="?([^"\r\n]+)"?\s*$/m.exec(text);
  const major = m ? majorFromVersion(m[1]!) : null;
  return m && major !== null ? { version: m[1]!, major } : null;
}

export function parseJavaVersionOutput(text: string): { version: string; major: number; home: string | null } | null {
  const m = /version "([^"]+)"/.exec(text);
  const major = m ? majorFromVersion(m[1]!) : null;
  if (!m || major === null) return null;
  return { version: m[1]!, major, home: /^\s*java\.home = (.+?)\s*$/m.exec(text)?.[1] ?? null };
}

// setup-java's suffixes per Node process.arch. Its README says _ARM64, but
// Apple-silicon runners get _AARCH64, so accept both.
const ARCH_SUFFIXES: Readonly<Record<string, string[]>> = { x64: ["X64"], arm64: ["ARM64", "AARCH64"], ia32: ["X86"] };

export function wpilibRoot(e: JdkEnvironment = {}): string {
  const platform = e.platform ?? process.platform;
  if (platform === "win32") return path.win32.join((e.env ?? process.env)["PUBLIC"] ?? "C:\\Users\\Public", "wpilib");
  return path.posix.join((e.homedir ?? os.homedir()).replace(/\\/g, "/"), "wpilib");
}

/**
 * Candidate homes in lookup order: JAVA_HOME_<N>, JAVA_HOME_<N>_<ARCH> (host
 * arch first), WPILib's bundled JDKs (the project's season first, then newest
 * first), then JAVA_HOME. `java` on PATH is tried last by resolveJdk.
 */
export function candidateHomes(
  major: number,
  projectYear: string | null,
  e: JdkEnvironment = {},
): { home: string; source: string }[] {
  const env = e.env ?? process.env;
  const out: { home: string; source: string }[] = [];
  const exact = env[`JAVA_HOME_${major}`];
  if (exact) out.push({ home: exact, source: `JAVA_HOME_${major}` });
  const prefix = `JAVA_HOME_${major}_`;
  const preferred = (ARCH_SUFFIXES[e.arch ?? process.arch] ?? []).map((s) => prefix + s);
  const rank = (k: string) => (preferred.includes(k) ? preferred.indexOf(k) : preferred.length);
  Object.keys(env)
    .filter((k) => k.startsWith(prefix) && /^[A-Z0-9]+$/.test(k.slice(prefix.length)) && env[k])
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .forEach((k) => out.push({ home: env[k]!, source: k }));

  const root = wpilibRoot(e);
  const join = (e.platform ?? process.platform) === "win32" ? path.win32.join : path.posix.join;
  let years: string[] = [];
  try {
    years = (e.readdir ?? readdirSync)(root).filter((d) => /^\d{4}(_\w+)?$/.test(d));
  } catch {
    // No WPILib install.
  }
  const season = projectYear?.slice(0, 4) ?? null;
  years.sort((a, b) => {
    const as = season !== null && a.startsWith(season) ? 1 : 0;
    const bs = season !== null && b.startsWith(season) ? 1 : 0;
    return bs - as || b.localeCompare(a);
  });
  for (const y of years) out.push({ home: join(root, y, "jdk"), source: `WPILib ${y}` });
  if (env["JAVA_HOME"]) out.push({ home: env["JAVA_HOME"], source: "JAVA_HOME" });
  return out;
}

const releaseCache = new Map<string, { version: string; major: number; home: string } | null>();

function defaultExec(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** Version of the JDK at `home`, from its release file or by running java. Cached per process. */
export function inspectJdkHome(
  home: string,
  e: JdkEnvironment = {},
): { version: string; major: number; home: string } | null {
  if (!e.readFile && releaseCache.has(home)) return releaseCache.get(home)!;
  const readFile = e.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let found: { version: string; major: number; home: string } | null = null;
  for (const dir of [home, path.join(home, "Contents", "Home")]) {
    try {
      const parsed = parseReleaseFile(readFile(path.join(dir, "release")));
      if (parsed) {
        found = { ...parsed, home: dir };
        break;
      }
    } catch {
      // Try the next layout.
    }
  }
  if (!found) {
    const bin = path.join(home, "bin", (e.platform ?? process.platform) === "win32" ? "java.exe" : "java");
    if ((e.exists ?? existsSync)(bin)) {
      const parsed = parseJavaVersionOutput((e.exec ?? defaultExec)(bin, ["-XshowSettings:properties", "-version"]));
      if (parsed) found = { version: parsed.version, major: parsed.major, home };
    }
  }
  if (!e.readFile) releaseCache.set(home, found);
  return found;
}

export function resolveJdk(
  requirement: JdkRequirement,
  projectYear: string | null,
  e: JdkEnvironment = {},
): JdkResolution {
  const rejected: JdkCandidate[] = [];
  const base = {
    required: requirement.major,
    reason: requirement.reason,
    ...(requirement.conflict ? { conflict: requirement.conflict } : {}),
  };
  for (const { home, source } of candidateHomes(requirement.major, projectYear, e)) {
    const info = inspectJdkHome(home, e);
    if (info?.major === requirement.major)
      return { ...base, chosen: { home: info.home, version: info.version, source }, rejected };
    rejected.push({ home, source, version: info?.version ?? null, major: info?.major ?? null });
  }
  const onPath = parseJavaVersionOutput((e.exec ?? defaultExec)("java", ["-XshowSettings:properties", "-version"]));
  if (onPath?.major === requirement.major) {
    return {
      ...base,
      chosen: { home: onPath.home ?? "(java on PATH)", version: onPath.version, source: "java on PATH" },
      rejected,
    };
  }
  rejected.push({
    home: onPath?.home ?? "",
    source: "java on PATH",
    version: onPath?.version ?? null,
    major: onPath?.major ?? null,
  });

  const wrong = rejected.filter((r) => r.major !== null).map((r) => `${r.source} is Java ${r.major}`);
  const message =
    `This project needs Java ${requirement.major} because ${requirement.reason}, but no Java ${requirement.major} was found` +
    (wrong.length ? ` (${wrong.join("; ")})` : "") +
    `. The WPILib installer for this season includes the right JDK; or install Java ${requirement.major} and set JAVA_HOME_${requirement.major}.`;
  return { ...base, rejected, diagnostic: { code: "jdk-mismatch", message } };
}
