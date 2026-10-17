import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import { importX } from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

// Which @codecoach/* packages each package may import. apps/* may import anything.
// Keep this in sync with the "dependencies" in each package.json.
const ALLOWED_DEPS = {
  core: [],
  providers: ["core"],
  pedagogy: ["core"],
  frc: ["core"],
  ui: ["core"],
  evals: ["core", "providers", "pedagogy", "frc"],
};

const noDeepImports = {
  group: ["@codecoach/*/*"],
  message: "Import a workspace package through its entry point, not its internals.",
};

const boundaries = Object.entries(ALLOWED_DEPS).map(([pkg, allowed]) => ({
  files: [`packages/${pkg}/**`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          noDeepImports,
          {
            group: ["@codecoach/*", ...allowed.map((dep) => `!@codecoach/${dep}`), `!@codecoach/${pkg}`],
            message: `@codecoach/${pkg} may only import ${allowed.length ? allowed.map((d) => `@codecoach/${d}`).join(", ") : "no other @codecoach packages"} (see eslint.config.mjs).`,
          },
        ],
      },
    ],
  },
}));

export default defineConfig(
  globalIgnores(["**/dist/", "**/out/", "**/coverage/", "fixtures/", "packages/evals/runs/", ".vscode-test/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { "import-x": importX },
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "import-x/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", ["parent", "sibling", "index"]],
          pathGroups: [{ pattern: "@codecoach/**", group: "internal" }],
          pathGroupsExcludedImportTypes: ["builtin"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // CommonJS files (e.g. the VS Code test suite, loaded by the extension host).
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["apps/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [noDeepImports] }] },
  },
  ...boundaries,
);
