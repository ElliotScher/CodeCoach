# Stage 0b: scaffolding and CI

## 1. Goal
Set up an empty but real monorepo:
- every package from PLAN.md's layout exists, builds, lints and has one passing test;
- the VS Code extension activates and shows a placeholder panel;
- one roboRIO and one SystemCore fixture each build with their own JDK;
- CI proves all of this on ubuntu, windows and macos.

**Exit criterion (from PLAN.md):** CI is green on ubuntu, windows and macos.

## 2. Depends on / unblocks
- **Depends on:** 0a (pins, doctor).
- **Unblocks:** 1 (core, pedagogy, frc and evals have somewhere to live), 2 (extension skeleton), 7 (`packages/ui` exists).

## 3. Deliverables
```
package.json                  # root scripts (§4.2)
pnpm-workspace.yaml
tsconfig.base.json            # strict, ES2023, moduleResolution "bundler"
tsconfig.json                 # project references to every package
eslint.config.mjs             # flat config, typescript-eslint, import ordering
.prettierrc.json
vitest.config.ts              # Vitest 4+ removed vitest.workspace.ts
tsconfig.tests.json           # typechecks tests against package sources
packages/{core,providers,pedagogy,frc,ui,evals}/
  package.json  tsconfig.json  src/index.ts  test/smoke.test.ts
apps/cli/                     # `codecoach --version` only
apps/vscode/                  # activates, registers an empty webview view
  package.json (contributes)  src/extension.ts  esbuild.mjs  test/
fixtures/
  java-roborio-hello/         # minimal command-based project, GradleRIO for the current roboRIO season
  java-systemcore-hello/      # same, targeting SystemCore (JDK 25)
  python-hello/               # minimal RobotPy project
  README.md                   # how fixtures are made and pinned
scripts/
  fixtures.mjs                # build/test fixtures with the right JDK
  ci-matrix-info.mjs          # prints the environment, for debugging CI
.github/workflows/ci.yml
.github/workflows/fixtures.yml
```

## 4. Design detail

### 4.1 TypeScript and module setup
- **Modules:** ESM everywhere (`"type": "module"`).
- **Build:** packages compile with `tsc -b` to `dist/` with declarations. Workspace deps use `workspace:*`.
- **VS Code extension:** VS Code's extension host loads CommonJS more reliably, so `esbuild` bundles `apps/vscode/src/extension.ts` to a **CJS** bundle (`dist/extension.cjs`). Checked at 0b: third-party sources say ESM extensions work from VS Code 1.100, but there's no official documentation, so the CJS bundle stays. Revisit in stage 2.
- **Webview:** a separate esbuild bundle that imports `@codecoach/ui`.
- **Strict settings:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **TypeScript version:** 6.0, not 7: typescript-eslint 8.71 supports `<6.1`.
- **Source condition:** each package exports `"@codecoach/source": "./src/index.ts"` ahead of `dist/`. Vitest, esbuild, `tsx` (via `node --conditions`) and `tsconfig.tests.json` (`customConditions`) resolve workspace packages to source, so tests, bundles and the CLI never need a prior `tsc -b`.
- **Package boundaries** are enforced by ESLint `no-restricted-imports`:
  - `pedagogy` and `frc` may import `core` types, but not each other's internals.
  - `providers` must not import `pedagogy`.
  - `apps/*` may import anything.

### 4.2 Root scripts
| Script | Does |
|---|---|
| `pnpm build` | `tsc -b` + esbuild bundles |
| `pnpm test` | `vitest run` (unit tests across the workspace) |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm typecheck` | `tsc -b --noEmit`-equivalent |
| `pnpm dev:vscode` | esbuild watch + launch the Extension Development Host |
| `pnpm test:vscode` | `@vscode/test-electron` integration tests |
| `pnpm package:vscode` | `@vscode/vsce package` → `apps/vscode/codecoach-<ver>.vsix` |
| `pnpm fixtures [build\|test] [name]` | `scripts/fixtures.mjs` (`--jdk <N>`, `--strict`) |
| `pnpm codecoach …` | runs `apps/cli` from source (via `tsx`) |
| `pnpm run doctor` | from 0a |

### 4.3 VS Code test runner on NixOS and elsewhere
`apps/vscode/test/run.mjs` calls `runTests({ vscodeExecutablePath: process.env.CODECOACH_VSCODE_EXECUTABLE, … })`. When the variable is unset (CI, stock machines), `@vscode/test-electron` downloads VS Code as usual, at `CODECOACH_VSCODE_VERSION` if set (CI pins 1.105.1, WPILib 2026's VS Code). On Linux CI, wrap the run in `xvfb-run -a`.

`CODECOACH_VSCODE_EXECUTABLE` must be VS Code's **Electron binary** (on NixOS, `<vscode>/lib/vscode/code`), not the `code` CLI launcher. The launcher hands off to a detached window and exits 0, so tests "pass" without running. Doctor flags a launcher script, and never runs the Electron binary, because `--version` there opens a full window.

### 4.4 Fixtures
- **Fixture metadata:** each fixture's `fixture.json` records:
  - `controller`: `roborio` | `systemcore`;
  - `language`: `java` | `cpp` | `python`;
  - `jdk`: 17 | 25 (null for Python);
  - the WPILib/GradleRIO version;
  - for Python, the `robotpy` version.
- **Where they come from:** fixtures are generated once from the WPILib templates and committed, so CI never needs the WPILib installer. The `gradlew` wrapper is committed, and `build/` and `.gradle/` are ignored.
- **`scripts/fixtures.mjs`:**
  - reads `fixture.json`;
  - resolves the JDK with the 0a probe (stage 1's `jdk.ts` later);
  - spawns `gradlew(.bat) build` with `JAVA_HOME` set to that JDK;
  - for Python, creates `.venv` and installs the pinned `robotpy`, then runs `python -m robotpy test` (verified with robotpy 2026.2.2 and pyfrc's built-in tests). `build` only byte-compiles;
  - `CODECOACH_PYTHON_LIBRARY_PATH` is prepended to the library path for Python runs (NixOS needs it for robotpy's wheels to find `libstdc++`; the NixHub shell sets it).
- **SystemCore:** at 0b, the 2027 season is at **2027.0.0-alpha-7** (GradleRIO plugin id `org.wpilib.GradleRIO`, Gradle 9.4.1, package `first.robot`, `CommandsV2.json`). The fixture pins it with `experimental: true`: `fixtures.mjs` reports its failures without failing the run, unless `--strict`. Revisit at kickoff.
- **Team number:** templates ship with `teamNumber: -1`, which GradleRIO rejects at configuration time. Fixtures use `0`.

### 4.5 CI (`.github/workflows/ci.yml`)
```
on: [push, pull_request]
jobs:
  checks:            # ubuntu-latest, windows-latest, macos-latest
    - actions/checkout
    - actions/setup-node (node-version-file: .node-version)
    - corepack enable
    - actions/setup-java (distribution: temurin, java-version: |  17  25 )
    - pnpm install --frozen-lockfile
    - pnpm run doctor --json
    - pnpm lint && pnpm typecheck && pnpm build && pnpm test
    - pnpm test:vscode            (xvfb-run on Linux)
    - pnpm package:vscode         (upload .vsix artifact from ubuntu only)
```
`fixtures.yml` is a separate workflow (it's slow because Gradle downloads WPILib artifacts):
- it runs on changes under `fixtures/**` or `packages/frc/**`, and nightly;
- it caches `~/.gradle/caches` and `~/.gradle/wrapper`;
- it builds every fixture on all three OSes.

Verified (setup-java README): each installed JDK gets `JAVA_HOME_<major>_<arch>` (`_X64`, or `_ARM64` on Apple-silicon runners), and the **last** version listed becomes `JAVA_HOME`.

### 4.6 Extension skeleton
- **`contributes`:**
  - a `codecoach` view container in the activity bar, holding the webview view `codecoach.chat`;
  - the command `codecoach.openChat`;
  - `activationEvents`: `onView:codecoach.chat` and `workspaceContains:**/build.gradle` / `**/pyproject.toml`.
- **`engines.vscode`:** `^1.105.0`. Verified from WPILibInstaller-Avalonia's `versions.gradle`: 2026.2.1 bundles VS Code 1.105.1, and 2027.0.0-alpha-7 bundles 1.134.0.
- **Webview:** renders "CodeCoach is coming soon" from `@codecoach/ui`, with a strict CSP (`default-src 'none'`, nonce-based scripts).

## 5. Task breakdown
**PR 1: workspace skeleton**
- [x] M: root configs (tsconfig, eslint, prettier, vitest), all packages with smoke tests
- [x] S: package boundary lint rules

**PR 2: extension and CLI skeletons**
- [x] M: `apps/vscode` (esbuild, webview with CSP, test runner honoring `CODECOACH_VSCODE_EXECUTABLE`)
- [x] S: `apps/cli` with commander, `--version`

**PR 3: fixtures**
- [x] M: generate `java-roborio-hello`, `java-systemcore-hello`, `python-hello`
- [x] M: `scripts/fixtures.mjs`

**PR 4: CI**
- [x] M: `ci.yml` on 3 OSes (includes 0a's doctor job); `fixtures.yml` with Gradle caching. Written and checked locally; not yet run on GitHub
- [ ] S: branch protection: `checks` required

## 6. Testing and verification
- Locally in the Nix shell: `pnpm build && pnpm test && pnpm test:vscode` pass. `pnpm fixtures build java-roborio-hello` uses JDK 17, and `… java-systemcore-hello` uses JDK 25 (the script prints the chosen JDK).
- CI green on all three OSes. The `.vsix` artifact installs into WPILib VS Code and shows the placeholder panel.
- Deliberately crossing JDKs (forcing 17 for the SystemCore fixture) fails with a clear message from `fixtures.mjs`, not a Gradle stack trace.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| ESM/CJS friction in the extension host | Bundle the extension to CJS with esbuild; keep the packages ESM |
| Gradle downloads make CI slow and flaky | Separate fixtures workflow, Gradle cache, nightly plus path-filtered runs |
| SystemCore GradleRIO not released yet | Pin the beta, mark the fixture `experimental`, revisit at kickoff |
| WPILib VS Code lags upstream VS Code | Keep `engines.vscode` low; test against WPILib's bundled version in stage 2 |

## 8. Open questions
- Should Turborepo (task caching) come in now or later? Later. `pnpm -r` is enough until builds take more than about a minute.
- Commit fixtures as full WPILib template projects, or as a minimal subset? Full templates are more realistic, and students' real projects look like them.

## 9. Out of scope
- Any coaching behavior (stage 1).
- Publishing to the VS Code Marketplace or Open VSX (stage 2).
