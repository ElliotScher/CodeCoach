import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
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
    // The VS Code integration tests run inside VS Code via `pnpm test:vscode`.
    exclude: [...configDefaults.exclude, "apps/vscode/test/**"],
  },
});
