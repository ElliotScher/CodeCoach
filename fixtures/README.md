# Fixtures

Small robot projects that CodeCoach's tests and evals run against. Each one is a directory with a `fixture.json`:

| Field | Meaning |
|---|---|
| `description` | One line on what the fixture is |
| `controller` | `roborio` or `systemcore` |
| `language` | `java`, `cpp` or `python` |
| `jdk` | `17` (roboRIO) or `25` (SystemCore); `null` for Python |
| `wpilib` | GradleRIO / WPILib version (Java and C++) |
| `robotpy` | robotpy version (Python) |
| `experimental` | `true` while the fixture's WPILib release is a pre-release; its failures are reported but not fatal |

Later stages add planted-bug fixtures named `<lang>-<controller>-<bug>/`, each with a `scenario.yaml` describing the simulated student and expected diagnosis.

## Running them

```sh
pnpm fixtures build                     # every fixture
pnpm fixtures test python-hello         # one fixture
pnpm fixtures build java-systemcore-hello --strict   # fail even though it's experimental
```

`scripts/fixtures.mjs` picks the JDK from `fixture.json` using the same lookup as `pnpm run doctor` (`JAVA_HOME_<N>`, WPILib's bundled JDK, `JAVA_HOME`, then `java` on `PATH`), prints which one it chose, and runs `gradlew build`/`test` with `JAVA_HOME` set to it. Python fixtures get their own `.venv` with the pinned robotpy; `build` byte-compiles the code and `test` runs `python -m robotpy test`.

Environment overrides:

- `CODECOACH_PYTHON` chooses the Python used to create the venv.
- `CODECOACH_PYTHON_LIBRARY_PATH` is prepended to the native library path for Python runs, for systems where robotpy's binary wheels can't find `libstdc++`.

## How these were made

They are unmodified WPILib templates, generated the way WPILib's VS Code extension generates new projects, then committed so CI never needs the WPILib installer. The Gradle wrapper is committed; `build/`, `.gradle/` and `.venv/` are ignored. The only change from the template is `teamNumber` set to `0` in `.wpilib/wpilib_preferences.json`, because GradleRIO refuses to configure a project without a team number.

| Fixture | Source |
|---|---|
| `java-roborio-hello` | WPILib 2026.2.1 "Command Robot" template: `vscode-wpilib` `v2026.2.1` `resources/gradle/{java,shared}` + `allwpilib` `v2026.2.1` `wpilibjExamples/.../templates/commandbased`, package renamed to `frc.robot`, `WPILibNewCommands.json` vendordep |
| `java-systemcore-hello` | WPILib 2027.0.0-alpha-7 "Command v2 Robot" template: `vscode-wpilib` `v2027.0.0-alpha-7` + `allwpilib` `v2027.0.0-alpha-7` `wpilibjExamples/.../templates/commandv2`, package renamed to `first.robot`, generated `first/Main.java`, `CommandsV2.json` vendordep. Experimental until the 2027 season release |
| `python-hello` | `robotpy init` (robotpy 2026.2.2), a minimal `TimedRobot` in `robot.py`, and pyfrc's built-in tests from `robotpy add-tests` |

To update a fixture for a new season, regenerate it from that season's templates (WPILib VS Code: *Create a new project* → Template → Java → the same template, team 0), copy it over the old directory, and update `fixture.json`.
