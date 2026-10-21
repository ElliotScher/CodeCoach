import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Prompt files are imported as strings (esbuild's "text" loader in the bundles).
      name: "markdown-as-text",
      enforce: "pre",
      transform(code, id) {
        return id.endsWith(".md") ? { code: `export default ${JSON.stringify(code)};`, map: null } : null;
      },
    },
  ],
  resolve: {
    // Tests run workspace packages from src/ through their "@codecoach/source" export.
    conditions: ["@codecoach/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@codecoach/source"],
    },
  },
  test: {
    include: ["{packages,apps}/*/test/**/*.test.{ts,tsx}"],
    // Windows CI runners are slow on first file-system access (the first copy in a file took ~6 s).
    testTimeout: 30_000,
    // The VS Code integration tests run inside VS Code via `pnpm test:vscode`.
    exclude: [...configDefaults.exclude, "apps/vscode/test/**"],
  },
});
