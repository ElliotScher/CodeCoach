import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/codecoach.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Bundle workspace packages from source so the CLI doesn't depend on `tsc -b` output.
  conditions: ["@codecoach/source"],
  // Prompt files are bundled as text.
  loader: { ".md": "text" },
  // CommonJS dependencies (yaml, …) call require() for Node built-ins; give the ESM bundle a real one.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  sourcemap: true,
  logLevel: "warning",
});

// Tree-sitter's runtime and grammars are WASM files loaded at run time; the
// frc package looks for them in a grammars/ folder next to the bundle.
const frc = createRequire(createRequire(import.meta.url).resolve("@codecoach/frc/package.json"));
mkdirSync("dist/grammars", { recursive: true });
for (const wasm of [
  "web-tree-sitter/web-tree-sitter.wasm",
  "tree-sitter-java/tree-sitter-java.wasm",
  "tree-sitter-cpp/tree-sitter-cpp.wasm",
  "tree-sitter-python/tree-sitter-python.wasm",
]) {
  copyFileSync(frc.resolve(wasm), path.join("dist/grammars", path.basename(wasm)));
}
