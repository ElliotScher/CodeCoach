// Bundles the extension host code (CommonJS, which VS Code's extension host
// loads most reliably) and the webview (an IIFE for the browser).
import { context } from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: true,
  // Bundle workspace packages from source so this doesn't depend on `tsc -b` output.
  conditions: ["@codecoach/source"],
  logLevel: "warning",
};

const builds = [
  {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...shared,
    entryPoints: ["src/webview/main.tsx"],
    outfile: "dist/webview.js",
    platform: "browser",
    target: "es2022",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
    minify: !watch,
  },
];

const contexts = await Promise.all(builds.map((b) => context(b)));
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("esbuild: watching apps/vscode");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
