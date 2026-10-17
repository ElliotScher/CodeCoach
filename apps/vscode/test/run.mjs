// Runs the integration tests inside a real VS Code (`pnpm test:vscode`).
// Uses CODECOACH_VSCODE_EXECUTABLE when set (e.g. a system VS Code on NixOS,
// where downloaded VS Code builds can't run); otherwise @vscode/test-electron
// downloads VS Code (CODECOACH_VSCODE_VERSION picks the version, default
// stable). On headless Linux, run under `xvfb-run -a`.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, "..");

const options = {
  extensionDevelopmentPath,
  extensionTestsPath: path.join(here, "suite", "index.cjs"),
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
};
if (process.env.CODECOACH_VSCODE_EXECUTABLE) {
  options.vscodeExecutablePath = process.env.CODECOACH_VSCODE_EXECUTABLE;
} else if (process.env.CODECOACH_VSCODE_VERSION) {
  // e.g. the version WPILib bundles, to prove engines.vscode holds (CI sets this).
  options.version = process.env.CODECOACH_VSCODE_VERSION;
}

try {
  await runTests(options);
} catch (err) {
  console.error("VS Code integration tests failed:", err);
  process.exit(1);
}
