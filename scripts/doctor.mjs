#!/usr/bin/env node
// `pnpm doctor`: checks the dev toolchain and optional FRC tools.
//
// Dependency-free on purpose, so it runs before `pnpm install`. Exits
// non-zero only when a required tool fails; optional tools are reported so
// contributors know which tests will be skipped on their machine.
//
//   --quiet  print only problems (used by the NixHub shellHook)
//   --json   machine-readable output (used by CI)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findJdk } from "./lib/jdk-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

// 22.12 is the floor for vitest and commander.
const MIN_NODE = [22, 12];
// RobotPy 2026 supports Python 3.10-3.14 (WPILib docs, "Python Installation Guide").
const MIN_PYTHON = [3, 10];
const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

/** Runs a command; returns { ok, out } with stdout+stderr combined. */
function run(cmd, args, { shell = false } = {}) {
  try {
    const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 };
    // pnpm and code are .cmd shims on Windows, which need a shell to run.
    // Pass one command string there: Node 24+ deprecates args with shell: true
    // (DEP0190). The args are fixed strings, so there is nothing to escape.
    const out = shell
      ? execFileSync([cmd, ...args].join(" "), { ...opts, shell: true })
      : execFileSync(cmd, args, opts);
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, missing: err.code === "ENOENT" };
  }
}

function firstLine(text) {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function versionAtLeast(found, min) {
  for (let i = 0; i < min.length; i++) {
    if ((found[i] ?? 0) !== min[i]) return (found[i] ?? 0) > min[i];
  }
  return true;
}

function pinnedPnpm() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  // "pnpm@12.9.0" or "pnpm@12.9.0+sha512.<hash>"
  return /^pnpm@([^+]+)/.exec(pkg.packageManager ?? "")?.[1] ?? null;
}

// Each check returns { id, name, required, wanted, found, status, details }.
// status: OK | MISSING | OLD | OPTIONAL (optional and missing/old) | INFO

function checkNode() {
  const found = process.versions.node;
  const ok = versionAtLeast(found.split(".").map(Number), MIN_NODE);
  return {
    id: "node",
    name: "Node.js",
    required: true,
    wanted: `>=${MIN_NODE.join(".")}`,
    found,
    status: ok ? "OK" : "OLD",
    details: ok ? "" : `install Node ${MIN_NODE.join(".")} or newer (see docs/dev-setup.md)`,
  };
}

function checkPnpm() {
  const wanted = pinnedPnpm();
  const r = run("pnpm", ["--version"], { shell: IS_WINDOWS });
  const found = r.ok ? firstLine(r.out) : null;
  let status = "OK";
  let details = "";
  if (!found) {
    status = "MISSING";
    details = "run `corepack enable`";
  } else if (found !== wanted) {
    status = "OLD";
    details = `pinned by packageManager; run \`corepack enable\` so pnpm follows the pin`;
  }
  return { id: "pnpm", name: "pnpm", required: true, wanted, found, status, details };
}

function checkGit() {
  const r = run("git", ["--version"]);
  const found = r.ok ? (/git version (\S+)/.exec(r.out)?.[1] ?? firstLine(r.out)) : null;
  return {
    id: "git",
    name: "git",
    required: true,
    wanted: "any",
    found,
    status: found ? "OK" : "MISSING",
    details: found ? "" : "install git",
  };
}

function checkJdk(major, purpose) {
  const r = findJdk(major);
  if (r.found) {
    return {
      id: `jdk${major}`,
      name: `JDK ${major}`,
      required: false,
      wanted: String(major),
      found: r.version,
      status: "OK",
      details: `${r.source}: ${r.home ?? "?"}`,
    };
  }
  const wrong = r.tried.filter((t) => t.got !== null).map((t) => `${t.source} is JDK ${t.got}`);
  return {
    id: `jdk${major}`,
    name: `JDK ${major}`,
    required: false,
    wanted: String(major),
    found: null,
    status: "OPTIONAL",
    details:
      `not found; needed for ${purpose}. Install the WPILib bundle or set JAVA_HOME_${major}` +
      (wrong.length ? ` (${wrong.join(", ")})` : ""),
  };
}

function checkPython() {
  const candidates = IS_WINDOWS
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];
  let best = null;
  for (const [cmd, pre] of candidates) {
    const r = run(cmd, [...pre, "--version"]);
    const v = /Python (\d+)\.(\d+)(?:\.(\d+))?/.exec(r.out);
    if (!r.ok || !v) continue;
    const parts = v.slice(1).filter(Boolean).map(Number);
    const venv = run(cmd, [...pre, "-m", "venv", "--help"]).ok;
    const cand = { cmd: [cmd, ...pre].join(" "), version: parts.join("."), parts, venv };
    if (versionAtLeast(parts, MIN_PYTHON) && venv) {
      best = cand;
      break;
    }
    best ??= cand;
  }
  const wanted = `>=${MIN_PYTHON.join(".")} + venv`;
  const base = { id: "python", name: "Python", required: false, wanted };
  if (!best) return { ...base, found: null, status: "OPTIONAL", details: "not found; needed for RobotPy fixtures" };
  if (!versionAtLeast(best.parts, MIN_PYTHON)) {
    return { ...base, found: best.version, status: "OPTIONAL", details: `${best.cmd} is too old for RobotPy` };
  }
  if (!best.venv) {
    return { ...base, found: best.version, status: "OPTIONAL", details: `${best.cmd} has no venv module` };
  }
  return { ...base, found: best.version, status: "OK", details: best.cmd };
}

/**
 * Version of a VS Code install, read from resources/app/package.json next to
 * the executable (Linux/Windows) or under Contents/Resources (macOS).
 */
function vsCodeVersionFromInstall(executable) {
  const dir = path.dirname(executable);
  for (const pkg of [
    path.join(dir, "resources", "app", "package.json"),
    path.join(dir, "..", "Resources", "app", "package.json"),
  ]) {
    try {
      return JSON.parse(readFileSync(pkg, "utf8")).version ?? null;
    } catch {
      // Not this layout; try the next one.
    }
  }
  return null;
}

function checkVsCode() {
  const base = { id: "vscode", name: "VS Code", required: false, wanted: "any" };
  const override = process.env.CODECOACH_VSCODE_EXECUTABLE;
  if (override) {
    // This must be VS Code's Electron binary, which @vscode/test-electron
    // launches directly. Never run it here: `--version` on the Electron
    // binary opens a full VS Code window instead of printing and exiting.
    if (!existsSync(override)) {
      return {
        ...base,
        found: null,
        status: "OPTIONAL",
        details: `CODECOACH_VSCODE_EXECUTABLE does not exist: ${override}`,
      };
    }
    if (readFileSync(override).subarray(0, 2).toString() === "#!") {
      return {
        ...base,
        found: null,
        status: "OPTIONAL",
        details: `CODECOACH_VSCODE_EXECUTABLE is the \`code\` CLI launcher script (${override}); point it at VS Code's Electron binary`,
      };
    }
    return {
      ...base,
      found: vsCodeVersionFromInstall(override) ?? "unknown version",
      status: "OK",
      details: "CODECOACH_VSCODE_EXECUTABLE",
    };
  }
  // `code` on PATH is the CLI launcher, for which `--version` prints and exits.
  const r = run("code", ["--version"], { shell: IS_WINDOWS });
  const found = r.ok ? firstLine(r.out) : null;
  return {
    ...base,
    found,
    status: found ? "OK" : "OPTIONAL",
    details: found ? "code on PATH" : "not found; needed for extension tests",
  };
}

function checkOwlet() {
  // CTRE documents `--help` (and no-argument usage) but not `--version`, so
  // any output from `--help` counts as installed.
  const r = run("owlet", ["--help"]);
  const found = !r.missing && r.out.trim() ? "installed" : null;
  return {
    id: "owlet",
    name: "CTRE owlet",
    required: false,
    wanted: "any",
    found,
    status: found ? "OK" : "OPTIONAL",
    details: found ? "" : "not on PATH; needed for .hoot log tests",
  };
}

function checkProviderKeys() {
  // Report only whether each key is set; never print values.
  const set = PROVIDER_KEYS.filter((k) => process.env[k]);
  return {
    id: "provider-keys",
    name: "Provider keys",
    required: false,
    wanted: "-",
    found: set.length ? set.join(", ") : "none set",
    status: "INFO",
    details: set.length ? "" : "only needed for live CLI runs and evals",
  };
}

function runChecks() {
  return [
    checkNode(),
    checkPnpm(),
    checkGit(),
    checkJdk(17, "roboRIO fixture tests"),
    checkJdk(25, "SystemCore fixture tests"),
    checkPython(),
    checkVsCode(),
    checkOwlet(),
    checkProviderKeys(),
  ];
}

function isFailure(c) {
  return c.required && c.status !== "OK";
}

function printTable(checks, { quiet }) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const colors = { OK: 32, MISSING: 31, OLD: 31, OPTIONAL: 33, INFO: 36 };
  const paint = (status, text) => (useColor ? `\x1b[${colors[status]}m${text}\x1b[0m` : text);

  const rows = quiet ? checks.filter((c) => isFailure(c) || c.status === "OPTIONAL") : checks;
  if (rows.length === 0) return;

  const header = ["Tool", "Required", "Wanted", "Found", "Status", "Details"];
  const cells = rows.map((c) => [
    c.name,
    c.required ? "yes" : "no",
    c.wanted ?? "",
    c.found ?? "-",
    c.status,
    c.details,
  ]);
  const widths = header.slice(0, -1).map((h, i) => Math.max(h.length, ...cells.map((r) => String(r[i]).length)));
  const fmt = (r, color) =>
    r
      .map((cell, i) => {
        if (i === r.length - 1) return cell;
        const padded = String(cell).padEnd(widths[i]);
        return color && i === 4 ? paint(cell, padded) : padded;
      })
      .join("  ")
      .trimEnd();

  console.log(fmt(header, false));
  console.log(widths.map((w) => "-".repeat(w)).join("  ") + "  -------");
  for (const r of cells) console.log(fmt(r, true));
}

const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!["--quiet", "--json"].includes(a)) {
    console.error(`doctor: unknown option ${a}\nusage: node scripts/doctor.mjs [--quiet] [--json]`);
    process.exit(2);
  }
}

const checks = runChecks();
const ok = !checks.some(isFailure);

if (args.has("--json")) {
  console.log(JSON.stringify({ ok, platform: process.platform, arch: process.arch, checks }, null, 2));
} else {
  printTable(checks, { quiet: args.has("--quiet") });
  if (!ok) console.log("\nRequired tools are missing or out of date. See docs/dev-setup.md.");
  else if (!args.has("--quiet")) console.log("\nAll required tools OK.");
}

process.exit(ok ? 0 : 1);
