// Node module hook: import .md files as their text (export default "<contents>").
// Used when running TypeScript from source with tsx (`pnpm codecoach`); the
// bundles use esbuild's "text" loader and tests use the vitest plugin instead.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFile } from "node:fs/promises";
      export async function load(url, context, next) {
        if (!url.endsWith(".md")) return next(url, context);
        const text = await readFile(new URL(url), "utf8");
        return { format: "module", source: "export default " + JSON.stringify(text) + ";", shortCircuit: true };
      }
    `),
);
