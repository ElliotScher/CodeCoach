// `pnpm package:vscode`: build and package apps/vscode/codecoach-<version>.vsix.
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const license = path.join(root, "LICENSE");
const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });

run(["esbuild.mjs"]);
// vsce wants a LICENSE next to package.json; the repo keeps one at the root.
copyFileSync(path.resolve(root, "../../LICENSE"), license);
try {
  // Dependencies are bundled by esbuild, so vsce must not try to collect node_modules.
  run([path.join(root, "node_modules/@vscode/vsce/vsce"), "package", "--no-dependencies"]);
} finally {
  rmSync(license, { force: true });
}
