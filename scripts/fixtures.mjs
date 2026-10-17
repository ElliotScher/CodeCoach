#!/usr/bin/env node
// `pnpm fixtures [build|test] [name...] [--jdk <N>] [--strict]`
//
// Builds or tests the robot projects in fixtures/ with the toolchain each one
// needs: Java fixtures get the JDK their fixture.json asks for (found with the
// same lookup as `pnpm run doctor`), Python fixtures get their own .venv with
// the pinned robotpy.
//
//   --jdk <N>  use JDK N instead of the fixture's own (to check the mismatch error)
//   --strict   fail on experimental fixtures too (normally reported but not fatal)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findJdk } from "./lib/jdk-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures");
const IS_WINDOWS = process.platform === "win32";
const CONTROLLER_JDK = { roborio: 17, systemcore: 25 };

class FixtureError extends Error {}

function usage(message) {
  if (message) console.error(`fixtures: ${message}`);
  console.error("usage: pnpm fixtures [build|test] [name...] [--jdk <N>] [--strict]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { action: "build", names: [], jdk: null, strict: false };
  const rest = [...argv];
  if (rest[0] === "build" || rest[0] === "test") opts.action = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === "--strict") opts.strict = true;
    else if (a === "--jdk") {
      opts.jdk = Number(rest.shift());
      if (!Number.isInteger(opts.jdk)) usage("--jdk needs a major version, e.g. --jdk 17");
    } else if (a.startsWith("-")) usage(`unknown option ${a}`);
    else opts.names.push(a);
  }
  return opts;
}

function loadFixtures() {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(FIXTURES, d.name, "fixture.json")))
    .map((d) => {
      const dir = path.join(FIXTURES, d.name);
      return { name: d.name, dir, ...JSON.parse(readFileSync(path.join(dir, "fixture.json"), "utf8")) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs a command in `cwd`, streaming output; throws FixtureError on failure. */
function run(cmd, args, { cwd, env, shell = false }) {
  console.log(`  $ ${[cmd, ...args].join(" ")}`);
  // .bat files need a shell on Windows; pass one string (see scripts/doctor.mjs).
  const r = shell
    ? spawnSync([cmd, ...args].join(" "), { cwd, env, stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  if (r.error) throw new FixtureError(`could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new FixtureError(`${path.basename(cmd)} exited with code ${r.status}`);
}

function runJava(fx, action, forcedJdk) {
  const wanted = fx.jdk ?? CONTROLLER_JDK[fx.controller];
  const major = forcedJdk ?? wanted;
  if (major !== wanted) {
    throw new FixtureError(
      `${fx.name} targets ${fx.controller}, which needs JDK ${wanted}, but JDK ${major} was requested. ` +
        `GradleRIO ${fx.wpilib} will not build with JDK ${major}.`,
    );
  }
  const jdk = findJdk(major);
  if (!jdk.found) {
    const tried = jdk.tried.map((t) => `${t.source}${t.got ? ` (JDK ${t.got})` : ""}`).join(", ");
    throw new FixtureError(
      `${fx.name} needs JDK ${major} and none was found (tried: ${tried}). ` +
        `Install the WPILib ${String(fx.wpilib).slice(0, 4)} bundle or set JAVA_HOME_${major}.`,
    );
  }
  console.log(`  JDK ${jdk.version} from ${jdk.source}: ${jdk.home}`);
  const env = {
    ...process.env,
    JAVA_HOME: jdk.home,
    PATH: `${path.join(jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const gradlew = IS_WINDOWS ? "gradlew.bat" : "./gradlew";
  run(gradlew, [action], { cwd: fx.dir, env, shell: IS_WINDOWS });
}

function findPython() {
  const candidates = process.env.CODECOACH_PYTHON
    ? [[process.env.CODECOACH_PYTHON, []]]
    : IS_WINDOWS
      ? [
          ["py", ["-3"]],
          ["python", []],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];
  for (const [cmd, pre] of candidates) {
    try {
      execFileSync(cmd, [...pre, "-c", "import venv"], { stdio: "ignore" });
      return [cmd, pre];
    } catch {
      // Try the next candidate.
    }
  }
  throw new FixtureError("no Python with the venv module found (set CODECOACH_PYTHON to choose one)");
}

function pythonEnv() {
  const env = { ...process.env };
  // Extra native-library path for robotpy's binary wheels, for systems where
  // libstdc++ isn't on the default search path (the NixHub shell sets this).
  const extra = process.env.CODECOACH_PYTHON_LIBRARY_PATH;
  if (extra && !IS_WINDOWS) {
    const key = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
    env[key] = [extra, process.env[key]].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function runPython(fx, action) {
  const venv = path.join(fx.dir, ".venv");
  const venvPython = IS_WINDOWS ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  const stamp = path.join(venv, ".codecoach-robotpy");
  const env = pythonEnv();

  if (!existsSync(venvPython)) {
    const [cmd, pre] = findPython();
    run(cmd, [...pre, "-m", "venv", ".venv"], { cwd: fx.dir, env });
  }
  if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== fx.robotpy) {
    run(venvPython, ["-m", "pip", "install", "--quiet", `robotpy==${fx.robotpy}`], { cwd: fx.dir, env });
    writeFileSync(stamp, `${fx.robotpy}\n`);
  }
  if (action === "build") {
    // Python has no build step; byte-compile to catch syntax errors.
    run(venvPython, ["-m", "compileall", "-q", "-x", "[\\\\/]\\.venv[\\\\/]", "."], { cwd: fx.dir, env });
  } else {
    run(venvPython, ["-m", "robotpy", "test"], { cwd: fx.dir, env });
  }
}

const opts = parseArgs(process.argv.slice(2));
const all = loadFixtures();
const unknown = opts.names.filter((n) => !all.some((f) => f.name === n));
if (unknown.length) usage(`unknown fixture(s): ${unknown.join(", ")}. Known: ${all.map((f) => f.name).join(", ")}`);
const selected = opts.names.length ? all.filter((f) => opts.names.includes(f.name)) : all;

const results = [];
for (const fx of selected) {
  console.log(
    `\n${opts.action} ${fx.name} (${fx.language}, ${fx.controller}${fx.experimental ? ", experimental" : ""})`,
  );
  try {
    if (fx.language === "java") runJava(fx, opts.action, opts.jdk);
    else if (fx.language === "python") runPython(fx, opts.action);
    else throw new FixtureError(`language "${fx.language}" is not supported yet`);
    results.push({ fx, ok: true });
  } catch (err) {
    if (!(err instanceof FixtureError)) throw err;
    console.error(`  error: ${err.message}`);
    results.push({ fx, ok: false });
  }
}

console.log("");
let failed = false;
for (const { fx, ok } of results) {
  const fatal = !ok && (!fx.experimental || opts.strict);
  failed ||= fatal;
  const label = ok ? "ok" : fatal ? "FAILED" : "failed (experimental, not fatal)";
  console.log(`${label.padEnd(34)} ${fx.name}`);
}
process.exit(failed ? 1 : 0);
