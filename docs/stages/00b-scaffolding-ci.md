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
vitest.workspace.ts
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
- **VS Code extension:** VS Code's extension host loads CommonJS more reliably, so `esbuild` bundles `apps/vscode/src/extension.ts` to a **CJS** bundle (`dist/extension.cjs`). *Verify* the current state of ESM extension support and drop the CJS step if it's stable.
- **Webview:** a separate esbuild bundle that imports `@codecoach/ui`.
- **Strict settings:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
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
| `pnpm fixtures [build\|test] [name]` | `scripts/fixtures.mjs` |
| `pnpm codecoach …` | runs `apps/cli` from source (via `tsx`) |
| `pnpm run doctor` | from 0a |

### 4.3 VS Code test runner on NixOS and elsewhere
`apps/vscode/test/run.mjs` calls `runTests({ vscodeExecutablePath: process.env.CODECOACH_VSCODE_EXECUTABLE, … })`. When the variable is unset (CI, stock machines), `@vscode/test-electron` downloads VS Code as usual. On Linux CI, wrap the run in `xvfb-run -a`.

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
  - for Python, creates `.venv` and installs the pinned `robotpy`, then runs `python -m robotpy test` (*verify* the command for the current RobotPy release).
- **SystemCore:** the SystemCore fixture depends on GradleRIO for the 2027 season. If that's only in beta, pin the beta and mark the fixture `experimental: true` (allowed to fail in CI) until the season release. *Verify* availability when 0b starts.

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

*Verify:* when `setup-java` installs several versions, it exports `JAVA_HOME_17_X64` and `JAVA_HOME_25_X64` (`_ARM64` on Apple-silicon macOS runners), and `JAVA_HOME` points at the **last** version listed.

### 4.6 Extension skeleton
- **`contributes`:**
  - a `codecoach` view container in the activity bar, holding the webview view `codecoach.chat`;
  - the command `codecoach.openChat`;
  - `activationEvents`: `onView:codecoach.chat` and `workspaceContains:**/build.gradle` / `**/pyproject.toml`.
- **`engines.vscode`:** at most the VS Code version WPILib ships for the current season (*verify*), so it installs into WPILib VS Code.
- **Webview:** renders "CodeCoach is coming soon" from `@codecoach/ui`, with a strict CSP (`default-src 'none'`, nonce-based scripts).

## 5. Task breakdown
**PR 1: workspace skeleton**
- [ ] M: root configs (tsconfig, eslint, prettier, vitest), all packages with smoke tests
- [ ] S: package boundary lint rules

**PR 2: extension and CLI skeletons**
- [ ] M: `apps/vscode` (esbuild, webview with CSP, test runner honoring `CODECOACH_VSCODE_EXECUTABLE`)
- [ ] S: `apps/cli` with commander/citty, `--version`

**PR 3: fixtures**
- [ ] M: generate and commit `java-roborio-hello`, `java-systemcore-hello`, `python-hello`
- [ ] M: `scripts/fixtures.mjs`

**PR 4: CI**
- [ ] M: `ci.yml` on 3 OSes; `fixtures.yml` with Gradle caching
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
