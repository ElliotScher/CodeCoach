// Dependency-free JDK finder used by `pnpm doctor`.
//
// The lookup order is the same one stage 1's resolver (packages/frc/src/jdk.ts)
// uses, so doctor reports what the coach will actually pick:
//   1. JAVA_HOME_<N>, then JAVA_HOME_<N>_X64 / JAVA_HOME_<N>_ARM64 (actions/setup-java)
//   2. WPILib's bundled JDK, newest season first
//   3. JAVA_HOME
//   4. `java` on PATH
// Once jdk.ts exists, doctor imports that instead and this file goes away.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Major version from a version string: "17.0.20" -> 17, "1.8.0_292" -> 8, "25" -> 25. */
export function majorFromVersion(version) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(version).trim());
  if (!m) return null;
  const first = Number(m[1]);
  // Java 8 and older report themselves as 1.x.
  if (first === 1 && m[2] !== undefined) return Number(m[2]);
  return first;
}

/** Parses a JDK `release` file. Returns { version, major } or null. */
export function parseReleaseFile(text) {
  const m = /^JAVA_VERSION="?([^"\r\n]+)"?\s*$/m.exec(text);
  if (!m) return null;
  const major = majorFromVersion(m[1]);
  return major === null ? null : { version: m[1], major };
}

/**
 * Parses `java -version` / `java -XshowSettings:properties -version` output
 * (both go to stderr). Returns { version, major, home } or null.
 */
export function parseJavaVersionOutput(text) {
  const m = /version "([^"]+)"/.exec(text);
  if (!m) return null;
  const major = majorFromVersion(m[1]);
  if (major === null) return null;
  const home = /^\s*java\.home = (.+?)\s*$/m.exec(text)?.[1] ?? null;
  return { version: m[1], major, home };
}

/** WPILib install roots: ~/wpilib on Linux/macOS, C:\Users\Public\wpilib on Windows. */
export function wpilibRoot({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === "win32") {
    const pub = env.PUBLIC ?? "C:\\Users\\Public";
    return path.win32.join(pub, "wpilib");
  }
  return path.join(homedir, "wpilib");
}

/** WPILib season directories under `root`, newest first. */
export function wpilibYears(root, { readdir = readdirSync } = {}) {
  let entries;
  try {
    entries = readdir(root);
  } catch {
    return [];
  }
  return entries.filter((e) => /^\d{4}$/.test(e)).sort((a, b) => Number(b) - Number(a));
}

/**
 * Candidate JDK homes for `major`, in lookup order. `java` on PATH is not
 * included here because it has no home until we run it.
 * TODO(verify): the SystemCore-era WPILib install path, once the 2027 installer ships.
 */
export function candidateHomes(major, ctx = {}) {
  const env = ctx.env ?? process.env;
  const out = [];
  for (const name of [`JAVA_HOME_${major}`, `JAVA_HOME_${major}_X64`, `JAVA_HOME_${major}_ARM64`]) {
    if (env[name]) out.push({ source: name, home: env[name] });
  }
  const root = wpilibRoot(ctx);
  const join = (ctx.platform ?? process.platform) === "win32" ? path.win32.join : path.join;
  for (const year of wpilibYears(root, ctx)) {
    out.push({ source: `WPILib ${year}`, home: join(root, year, "jdk") });
  }
  if (env.JAVA_HOME) out.push({ source: "JAVA_HOME", home: env.JAVA_HOME });
  return out;
}

function javaBinary(home, platform) {
  return path.join(home, "bin", platform === "win32" ? "java.exe" : "java");
}

/** Reads the version of the JDK at `home`, from its release file or by running java. */
export function inspectHome(home, ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const readFile = ctx.readFile ?? ((p) => readFileSync(p, "utf8"));
  // macOS JDK bundles keep the real home under Contents/Home.
  for (const dir of [home, path.join(home, "Contents", "Home")]) {
    try {
      const parsed = parseReleaseFile(readFile(path.join(dir, "release")));
      if (parsed) return { ...parsed, home: dir };
    } catch {
      // No release file here; try the next layout.
    }
  }
  const bin = javaBinary(home, platform);
  if (!(ctx.exists ?? existsSync)(bin)) return null;
  const parsed = parseJavaVersionOutput(runJava(bin, ctx));
  return parsed ? { version: parsed.version, major: parsed.major, home } : null;
}

function runJava(bin, ctx) {
  const exec = ctx.exec ?? defaultExec;
  return exec(bin, ["-XshowSettings:properties", "-version"]);
}

/** Runs a command and returns stdout+stderr, or "" if it can't be run. */
export function defaultExec(cmd, args) {
  // java prints its version to stderr, even on success, so keep both streams.
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/**
 * Finds a JDK with the given major version.
 * Returns { found: true, major, version, home, source } or
 * { found: false, major, tried: [{ source, home, got }] } so callers can say
 * what they looked at, which matters when a student has the wrong JDK.
 */
export function findJdk(major, ctx = {}) {
  const tried = [];
  for (const { source, home } of candidateHomes(major, ctx)) {
    const info = inspectHome(home, ctx);
    if (info?.major === major) return { found: true, major, version: info.version, home: info.home, source };
    tried.push({ source, home, got: info?.major ?? null });
  }
  const parsed = parseJavaVersionOutput(runJava("java", ctx));
  if (parsed?.major === major) {
    return { found: true, major, version: parsed.version, home: parsed.home, source: "java on PATH" };
  }
  tried.push({ source: "java on PATH", home: parsed?.home ?? null, got: parsed?.major ?? null });
  return { found: false, major, tried };
}
