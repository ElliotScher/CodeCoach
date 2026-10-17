# Stage 0a: dev environment

## 1. Goal
Any contributor on Linux, macOS or Windows can go from a fresh machine to a working CodeCoach dev setup with Node 22 and corepack, and nothing else is required. You also get a personal NixOS shell, kept in NixHub, that provides the same tool versions plus both robot JDKs. The repo itself contains no Nix files.

**Exit criteria (from PLAN.md):**
- `pnpm run doctor` passes in the Nix shell and on CI's ubuntu, windows and macos runners.
- `pnpm run doctor` detects both JDK 17 and JDK 25 where they are installed.
- Secret files and build output are ignored by git.

## 2. Depends on / unblocks
- **Depends on:** nothing.
- **Unblocks:** everything else. 0b needs the pinned toolchain to scaffold and build.

## 3. Deliverables
| Path | Purpose | Status |
|---|---|---|
| `~/Documents/NixHub/dev/FRC/CodeCoach/flake.nix` (+ `flake.lock`) | Personal Nix dev shell (outside the repo) | **Done**: verified and committed in NixHub (`73be872`) |
| `.node-version` | `22`, read by nvm, fnm, volta and `actions/setup-node` | |
| `package.json` (root, private) | `packageManager: "pnpm@12.9.0"`, `engines.node: ">=22"`, root scripts | |
| `pnpm-workspace.yaml` | Workspace globs (`packages/*`, `apps/*`, `services/*`) | |
| `scripts/doctor.mjs` | Checks the toolchain and optional tools | |
| `scripts/lib/jdk-probe.mjs` | Small standalone JDK finder used by doctor (stage 1's `packages/frc/src/jdk.ts` supersedes it and doctor then imports that) | |
| `docs/dev-setup.md` | Manual install per OS, VS Code setup, troubleshooting | |
| `README.md` | Rewritten as described in PLAN.md §7 | |
| `.gitignore` | As described in PLAN.md §7 | |
| `.vscode/extensions.json` | Recommended extensions (ESLint, Vitest, WPILib) | |

## 4. Design detail

### 4.1 NixHub flake (done)
The flake is in place. For the record, here is what it provides and why:
- **Packages:** `nodejs_22` and `pnpm` (nixpkgs ships 12.9.0, which is why the project pins that exact version), `jdk17` + `jdk25`, and `python3`.
- **JDKs:** both are in one shell, unlike FRC 190's Robot_Code flake, which has one shell per controller. CodeCoach builds roboRIO *and* SystemCore fixtures in the same session.
- **Environment:**
  - `JAVA_HOME_17` and `JAVA_HOME_25`: names chosen to match `actions/setup-java`'s `JAVA_HOME_<N>_X64`, so one resolver handles both;
  - `JAVA_HOME`: defaults to 17;
  - `GRADLE_OPTS=-Dorg.gradle.console=rich`;
  - `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and `ELECTRON_OVERRIDE_DIST_PATH=${pkgs.electron}/libexec/electron`, because npm's Electron doesn't run on NixOS;
  - `CODECOACH_VSCODE_EXECUTABLE`: set in the shellHook from the system `code`, so no second unfree VS Code is pulled in.
- **shellHook:** prints the banner, runs `pnpm install` automatically if `node_modules` is missing or older than `pnpm-lock.yaml`, then lists the common commands.
- **Checks:** `nix flake check` passes, and `nix develop` reports Node v22.23.3, pnpm 12.9.0, OpenJDK 17.0.20 and OpenJDK 25.0.4.
- **Remaining:** run `nixos-rebuild switch` to get the `CodeCoach` alias. Add `postgresql` at stage 9.
- **Follow-up:** once 0a lands, add `node scripts/doctor.mjs --quiet` to the shellHook, matching Micnote's pattern.

### 4.2 Toolchain pins
```jsonc
// package.json (root)
{
  "name": "codecoach",
  "private": true,
  "packageManager": "pnpm@12.9.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "doctor": "node scripts/doctor.mjs"
    // build/test/lint/dev:vscode/evals added in 0b+
  }
}
```
- **Single source:** these pins live only here and in `.node-version`. If the pins change, the NixHub flake follows them, never the other way round.
- **Contributor setup:** `corepack enable` gives the exact pnpm version on every OS. There is no global pnpm install.

### 4.3 `pnpm run doctor`
It has to be `pnpm run doctor`, not `pnpm doctor`: pnpm 12 has a built-in `doctor` command that takes precedence over the script.

`pnpm run doctor` is a single Node script with no dependencies, so it runs *before* `pnpm install`. It prints a table of tool, required version, found version and status (OK / MISSING / OLD / OPTIONAL), and exits non-zero only if a **required** tool fails.

| Check | Required? | How |
|---|---|---|
| Node ≥ 22 | yes | `process.versions.node` |
| pnpm = pinned | yes | `pnpm --version` vs. `packageManager` |
| git | yes | `git --version` |
| JDK 17 | optional (needed for roboRIO fixture tests) | JDK probe (§4.4) |
| JDK 25 | optional (needed for SystemCore fixture tests) | JDK probe |
| Python ≥ 3.10 + venv | optional (RobotPy fixtures) | `python3`/`py -3` `--version`, `-m venv --help` (verified: RobotPy 2026 supports Python 3.10–3.14; re-check each season) |
| VS Code | optional (extension tests) | `CODECOACH_VSCODE_EXECUTABLE`, then `code` on PATH |
| CTRE owlet | optional (hoot logs) | `owlet --help` on PATH (verified: CTRE documents `--help` and `-f wpilog <in> <out>`, but no `--version`) |
| Provider keys | info only | reports which of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` are **set**, never their values |

Flags:
- `--quiet` prints only failures;
- `--json` gives machine-readable output for CI.

### 4.4 JDK probe (`scripts/lib/jdk-probe.mjs`)
This is the same lookup order that stage 1's resolver will use, kept dependency-free:
1. `JAVA_HOME_<N>`, then any `JAVA_HOME_<N>_<ARCH>` (`_X64`, `_ARM64`, `_AARCH64`, ...), host architecture first.
2. WPILib's bundled JDK:
   - `~/wpilib/<year>/jdk` on Linux and macOS;
   - `C:\Users\Public\wpilib\<year>\jdk` on Windows.

   Scan the year directories newest-first. *Verify* the SystemCore-era install path.
3. `JAVA_HOME`.
4. `java` on PATH.

Each candidate's major version is read from `<home>/release` (`JAVA_VERSION="25.0.4"`), falling back to `java -version` output. Doctor reports *which* source satisfied each version, which is useful when a student's VS Code picks the wrong one.

### 4.5 `docs/dev-setup.md`
- **Per OS:** install Node 22 (nodejs.org installer, Homebrew, winget `OpenJS.NodeJS.LTS`, or fnm/nvm), run `corepack enable`, then `pnpm install && pnpm run doctor`.
- **JDKs:** the easiest route is the WPILib installer for each season (it bundles the matching JDK). Otherwise use Temurin 17 and 25, and set `JAVA_HOME_17` / `JAVA_HOME_25`.
- **VS Code:** recommended extensions, and how to launch the Extension Development Host (filled in by 0b/2).
- **Troubleshooting:**
  - "corepack: pnpm not found";
  - Windows long paths (`git config core.longpaths true`);
  - corporate proxies blocking the provider APIs;
  - Gradle picking the wrong JDK.

### 4.6 README and .gitignore
The contents are as listed in PLAN.md §7. The README's development section is a four-line copy-paste block that links to `docs/dev-setup.md`. The README does not mention Nix.

## 5. Task breakdown
**NixHub (separate repo)**
- [x] M: `dev/FRC/CodeCoach/flake.nix` + lock, verified with `nix flake check` and `nix develop`
- [x] S: commit in NixHub (`73be872`)
- [ ] S: `nixos-rebuild switch` for the alias
- [x] S: add `node scripts/doctor.mjs --quiet` to the shellHook (edited in NixHub, not committed)

**PR 1: pins and doctor**
- [x] S: `.node-version`, root `package.json`, `pnpm-workspace.yaml`
- [x] M: `scripts/doctor.mjs` + `scripts/lib/jdk-probe.mjs`
- [x] S: unit tests for the probe's version parsing (run with `node --test` until vitest arrives in 0b); `pnpm run test:scripts`

**PR 2: repo hygiene and docs**
- [x] S: `.gitignore` (plus `.idea/`, `Thumbs.db`), `.vscode/extensions.json`
- [x] M: README rewrite
- [x] M: `docs/dev-setup.md`

**PR 3: doctor in CI** (lands with 0b's workflow)
- [x] S: `doctor` job on ubuntu, windows and macos with `setup-java` installing 17 and 25; asserts both are detected (the `checks` job in 0b's `ci.yml`)

## 6. Testing and verification
- `nix develop ~/Documents/NixHub/dev/FRC/CodeCoach -c pnpm run doctor` → all OK, both JDKs found via `JAVA_HOME_17`/`JAVA_HOME_25`.
- On CI's three OSes: `corepack enable && pnpm run doctor --json` → required checks OK; JDK 17 and 25 found via `JAVA_HOME_17_X64`/`JAVA_HOME_25_X64`.
- With `JAVA_HOME_25` unset in a test env, doctor reports JDK 25 as OPTIONAL-MISSING and still exits 0.
- `git check-ignore -v node_modules/x dist/x .env fixtures/a/build/x packages/evals/runs/x` matches every path.
- **Manual:** a fresh Windows VM goes from nothing to a passing doctor using only the README.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| nixpkgs' pnpm moves past the pinned version | The pinned version is the source of truth. Bump the pin deliberately, or if nixpkgs lags, use `corepack` inside the Nix shell (`corepack enable --install-directory`) |
| The WPILib JDK path changes for the SystemCore seasons | The probe scans by pattern and reports what it found; `*verify*` when the 2027 installer ships |
| Students' machines have only a JRE, or the wrong JDK | Doctor and the resolver say *which* JDK is needed and where to get it (the WPILib installer) |
| corepack disabled or missing in some Node distributions | `docs/dev-setup.md` documents `npm i -g corepack` as a fallback |

## 8. Open questions
- Should doctor also check the WPILib VS Code extension version? Probably in stage 2, when the extension is being tested against it.
- Is Linux aarch64 (e.g. ARM laptops) worth a CI runner? It's cheap to add once the matrix exists.

## 9. Out of scope
- Extension packaging and release (stage 2) and desktop installers (stage 7).
- Dev containers and Codespaces (can be added later if contributors ask).
- Committing anything in NixHub without being asked.
