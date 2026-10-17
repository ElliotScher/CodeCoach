# Development setup

CodeCoach builds on plain Node.js with pnpm scripts, so the same steps work on Windows, macOS and Linux. Nothing needs WSL, bash, `make` or a global pnpm install.

## Required

| Tool | Version | Why |
|---|---|---|
| Node.js | 22 or newer (`.node-version` says `22`) | Everything |
| pnpm | exactly the version in `package.json`'s `packageManager` | Installed for you by corepack |
| git | any recent | Cloning, and some tests |

## Optional

`pnpm run doctor` reports these. Tests that need a missing tool are skipped with a message saying which tool to install.

| Tool | Needed for |
|---|---|
| JDK 17 | Building roboRIO fixture projects |
| JDK 25 | Building SystemCore fixture projects |
| Python 3.10+ with `venv` | RobotPy fixtures (RobotPy 2026 supports Python 3.10–3.14) |
| VS Code | Running the extension and its tests |
| CTRE `owlet` | `.hoot` log tests ([download from CTRE](https://docs.ctr-electronics.com/cli-tools)) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Live CLI runs and evals only |

## 1. Install Node 22

Pick one:

- **Windows:** the installer from [nodejs.org](https://nodejs.org/), or `winget install OpenJS.NodeJS.LTS`.
- **macOS:** the installer from [nodejs.org](https://nodejs.org/), or `brew install node@22`.
- **Linux:** your distribution's Node 22 package, or the nodejs.org binaries.
- **Any OS, with a version manager:** [fnm](https://github.com/Schniz/fnm), [nvm](https://github.com/nvm-sh/nvm) / [nvm-windows](https://github.com/coreybutler/nvm-windows) or [Volta](https://volta.sh/). fnm, nvm and Volta read `.node-version` automatically.

Check with `node --version`.

## 2. Enable corepack and install

From the repo root:

```sh
corepack enable
pnpm install
pnpm run doctor
```

`corepack enable` makes `pnpm` resolve to the exact version pinned in `package.json`, so everyone runs the same pnpm.

Run doctor as `pnpm run doctor`. A bare `pnpm doctor` runs pnpm's own built-in health check instead of ours.

Doctor flags:

- `--quiet` prints only problems.
- `--json` prints machine-readable output (CI uses this).

You can also run it before `pnpm install` with `node scripts/doctor.mjs`; it has no dependencies.

## 3. JDKs (optional)

CodeCoach never trusts the ambient `JAVA_HOME` alone. It looks for each JDK version in this order and reports which one it found:

1. `JAVA_HOME_17` / `JAVA_HOME_25` (or the `_X64` / `_ARM64` variants that GitHub's `actions/setup-java` sets)
2. WPILib's bundled JDK, newest season first:
   - Windows: `C:\Users\Public\wpilib\<year>\jdk`
   - macOS and Linux: `~/wpilib/<year>/jdk`
3. `JAVA_HOME`
4. `java` on `PATH`

The easiest route is the **WPILib installer** for each season, which bundles the matching JDK. Otherwise install [Temurin](https://adoptium.net/) 17 and 25 and set the per-version variables:

```sh
# macOS / Linux (add to your shell profile)
export JAVA_HOME_17=/path/to/jdk-17
export JAVA_HOME_25=/path/to/jdk-25
```

```powershell
# Windows (PowerShell, persists for your user)
[Environment]::SetEnvironmentVariable("JAVA_HOME_17", "C:\Program Files\Eclipse Adoptium\jdk-17...", "User")
[Environment]::SetEnvironmentVariable("JAVA_HOME_25", "C:\Program Files\Eclipse Adoptium\jdk-25...", "User")
```

## 4. Python (optional)

Install Python 3.10 or newer from [python.org](https://www.python.org/downloads/) (on Windows, keep the `py` launcher option checked). Doctor tries `py -3`, `python` and `python3` on Windows, and `python3` then `python` elsewhere. RobotPy itself is installed into each fixture's own virtual environment by the test setup, so you don't need to install it globally.

## 5. VS Code

Opening the repo in VS Code suggests the recommended extensions (`.vscode/extensions.json`): ESLint, Vitest and WPILib.

Doctor looks for VS Code via `CODECOACH_VSCODE_EXECUTABLE` first, then `code` on `PATH`. Set the variable if your VS Code isn't on `PATH` or you want the extension tests to use a specific install.

Launching the extension in an Extension Development Host is documented once the extension exists (stage 2).

## Troubleshooting

### `corepack: command not found` or `pnpm: command not found`

Some Node distributions don't bundle corepack. Install it with `npm install -g corepack`, then run `corepack enable` again. On Windows, open a new terminal afterwards so `PATH` picks it up.

### Doctor says pnpm is OLD

A globally installed pnpm is shadowing corepack's. Uninstall it (`npm uninstall -g pnpm`, or remove it from your package manager) and run `corepack enable`.

### Windows: "Filename too long" during clone or install

Enable long paths for git:

```sh
git config --global core.longpaths true
```

If that isn't enough, enable Win32 long paths in Windows (Group Policy or the `LongPathsEnabled` registry value).

### School or corporate network blocks the provider APIs

CodeCoach talks to `api.anthropic.com`, `api.openai.com` and `generativelanguage.googleapis.com`. If those are blocked, set `HTTPS_PROXY` to your network's proxy, or use a network that allows them. `pnpm install` also needs `registry.npmjs.org`.

### Gradle uses the wrong JDK

Gradle uses `JAVA_HOME` (or `java` on `PATH`) unless told otherwise, which may not be the JDK a project needs: roboRIO projects need 17, SystemCore projects need 25. Run `pnpm run doctor` to see which JDKs were found and where, then set `JAVA_HOME_17` / `JAVA_HOME_25` as in step 3. From stage 1 on, CodeCoach's build runner passes the right JDK to Gradle for each project.
