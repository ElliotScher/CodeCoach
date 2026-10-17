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
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "warning",
});
