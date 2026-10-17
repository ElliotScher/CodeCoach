// `pnpm dev:vscode`: rebuild on change and open an Extension Development Host.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = process.env.CODECOACH_VSCODE_EXECUTABLE ?? "code";
const shell = process.platform === "win32" && !process.env.CODECOACH_VSCODE_EXECUTABLE;

const watcher = spawn(process.execPath, ["esbuild.mjs", "--watch"], { cwd: root, stdio: "inherit" });
// Give esbuild a moment for the first build before VS Code loads dist/.
setTimeout(() => {
  const args = [`--extensionDevelopmentPath=${root}`];
  // Windows `code` is a .cmd shim; pass one command string with shell (see scripts/doctor.mjs).
  const host = shell
    ? spawn([code, ...args.map((a) => `"${a}"`)].join(" "), { stdio: "inherit", shell: true })
    : spawn(code, args, { stdio: "inherit" });
  host.on("error", (err) => console.error(`Could not launch VS Code (${code}): ${err.message}`));
}, 1500);

process.on("SIGINT", () => {
  watcher.kill();
  process.exit(0);
});
