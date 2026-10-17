# CodeCoach: final implementation plan

## Context
In FRC, software mentors tend to cluster on the teams that are already strong. Many other teams have no software mentor at all, and their students teach themselves as they go. Students from traditionally marginalized backgrounds feel this the most: they often stay away from software because nobody has ever told them they can do this work.

CodeCoach is a **virtual FRC software mentor**: a chat assistant built specifically for FRC that can read robot code, build output, simulation state and match logs. What sets it apart is *how* it helps. Like a good mentor, it **coaches rather than does**:

- It suggests rather than writes code.
- It asks the student to form a hypothesis before it explains a bug.
- It walks the student through debugging steps and designs small experiments with them.
- It analyzes logs *together* with the student, rather than handing over a verdict.
- It is warm, encouraging and never condescending, so students come away thinking "I can do this".

The repo is greenfield: only the README and LICENSE (BSD-3-Clause) exist.

### Decisions made
| Area | Decision |
|---|---|
| Form factor | A shared TypeScript core. It ships first as a **VS Code extension** that works inside WPILib VS Code; a standalone **Electron desktop app** comes later and reuses the same core and UI |
| Chat UI | CodeCoach always has **its own chat window**. It never hands the conversation off to a vendor's CLI UI |
| Providers | Anthropic, OpenAI and Google, all behind one `ChatProvider` interface. **Subscriptions are the main path**: no API-key spending (see Spending) |
| Spending | **No API-key spending for the rest of the project** unless the project owner explicitly lifts it after the feasibility checkpoint (stages 1–2 exit criteria met). Development and evals run on the owner's **Claude Pro/Max subscription through Claude Code in headless mode** (stage 1b), a development-only transport that is never shipped. The API-key adapters stay in the code, disabled unless explicitly opted in, and CI never needs a key |
| Subscriptions | CodeCoach keeps its own chat UI. The transport is either an official extension API (GitHub Copilot via VS Code's Language Model API) or the vendor's official runtime running **headlessly** (Claude Code for development; Codex app-server and Gemini CLI for students). Each student-facing adapter ships only after that vendor's terms are confirmed, including age limits (stage 6). A Claude subscription path for students needs Anthropic's approval |
| Ecosystems (v1) | Java command-based, AdvantageKit and log replay, C++, Python (RobotPy) |
| Controllers | roboRIO (JDK 17) **and** SystemCore (JDK 25). The JDK is chosen per project, never from the ambient `JAVA_HOME` |
| Guardrails | Set by the team mentor (L0–L3), default **L0 Socratic**. Enforced in code, not only in the prompt |
| Sponsor pool | Optional, **fully separate** from teams using their own subscriptions, and **built last** (stage 9) because it is the least likely to happen. It would spend a sponsor's API credits, so it also needs the spending gate lifted |
| Privacy | Local-first. No telemetry by default; conversations stay on the student's machine; keys live in the OS secret store |
| Nix | Not in the repo. Your personal flake lives in NixHub; contributors and CI use plain Node + corepack + pnpm scripts |

## Architecture
```
 [Student in WPILib VS Code]                 [Desktop app, stage 7]
   apps/vscode                                 apps/desktop (Electron)
   webview chat ── packages/ui (React) ──────── same UI
        │ postMessage                                │ IPC
        ▼                                            ▼
   packages/core     agent loop · session store · tool registry · budget meter
     ├─ packages/pedagogy   prompt layers · guardrail engine · response checker · debugging state machine
     ├─ packages/frc        project analyzer · code nav · JDK resolver · build/sim runner ·
     │                      FRC lint · log parsers (wpilog, dslog, hoot) · NT4 client · docs index
     └─ packages/providers  subscription transports · [API-key adapters, off] · [pool]
              │ stdio to the vendor's official runtime, user's own sign-in
              │ (Claude Code for development; vscode.lm / Codex / Gemini CLI for students)
              │ CodeCoach's tools offered to the runtime via packages/mcp-server
              ▼
      Claude Code / Copilot / Codex / Gemini CLI ──► vendor services

      Only if the owner lifts the spending gate:
        API-key adapters ──► Anthropic / OpenAI / Google APIs
        services/pool (stage 9) ──► provider APIs (sponsor keys)
```

### Repo layout
```
packages/
  core/            agent loop, ChatProvider interface, tool registry, session store, budget/cost
  providers/       anthropic, openai, google (API key) + subscription adapters (flagged) + pool (stage 9)
  pedagogy/        prompt layers, guardrail policy engine, response checker, debugging state machine
  frc/             project analyzer, FRC tools, JDK resolver, log parsers, NT4 client, docs index
  ui/              React chat UI shared by the VS Code webview and the desktop app
  evals/           scenario fixtures, simulated student, LLM-judge rubric, score matrix
  mcp-server/      (stage 1b) the tool registry exposed over MCP, for subscription runtimes
  pool-protocol/   (stage 9) shared types + API client for services/pool
apps/
  vscode/          VS Code extension
  cli/             `codecoach` dev harness: run the coach against a project from a terminal
  desktop/         (stage 7) Electron app
  pool-web/        (stage 9) team applications, mediator review, dashboards
services/
  pool/            (stage 9) allocation ledger + metering LLM proxy
fixtures/          small robot projects with planted bugs (roboRIO + SystemCore, Java/C++/Python)
scripts/           Node .mjs helpers (doctor, fixture setup, release); no bash or PowerShell needed
docs/              this plan; per-stage plans in docs/stages/ (index: docs/stages/README.md)
```

## 1. Provider layer (`packages/providers`)
- **One interface.** `ChatProvider` covers streaming, tool calls, prompt caching where the provider supports it, token usage reporting and model listing. The core agent loop is a manual loop over this interface (no vendor tool-runner helpers), so every provider behaves the same way.
- **Spending policy.** Until the owner lifts it (see Decisions), no code path spends API money by default:
  - API-key adapters refuse to run unless explicitly opted in (`--allow-api-spend` / `CODECOACH_ALLOW_API_SPEND=1`), and the UI hides API-key setup behind an experimental setting;
  - the subscription transports are the defaults: Claude Code for development (stage 1b), then Copilot, Codex and Gemini CLI for students (stage 6);
  - unit tests and CI use recorded or mocked streams and never need a key.
- **Transports and adapters:**
  | Provider | Transport | Status | Notes |
  |---|---|---|---|
  | Anthropic, development | **Claude Code, headless** (`claude -p`, stream-json), signed in with the owner's Pro/Max account | **Main path for development and evals** (stage 1b) | Development-only, never shipped: Anthropic doesn't allow third-party products to offer claude.ai login without approval. CodeCoach's tools over MCP, Claude Code's built-in tools off, pedagogy prompt injected and canary-checked. Usage shows as subscription limits, not dollars |
  | Anthropic, API key | `@anthropic-ai/sdk`, Messages API, streaming | Built in stage 1; **off unless opted in** | Default model `claude-opus-5-5` with adaptive thinking and an explicit `output_config.effort`; `claude-haiku-5-5` for cheap sub-tasks; prompt caching; mid-conversation system messages; append-only history; refusals and server-side fallbacks handled |
  | GitHub Copilot | VS Code Language Model API (`vscode.lm`) | Stage 6, first student-facing path | Many students get Copilot free; an official extension API |
  | OpenAI | Codex `app-server`, ChatGPT sign-in | Stage 6 | Built for third-party front ends |
  | Google | Gemini CLI (ACP mode), Google sign-in | Stage 6 | Consumer data-use terms shown in the privacy banner |
  | OpenAI / Google, API key | `openai` Responses API / `@google/genai` | **Deferred** (stage 3, only if the gate is lifted) | Model lists configurable; defaults chosen from evals |
- **Per-provider prompt tuning.** The pedagogy layer is provider-agnostic. Small adjustments live in `packages/pedagogy/src/providers/*.ts` and are tuned only against eval results.
- **Credentials.** Subscription runtimes keep their own sign-in; CodeCoach never sees or stores their tokens. If API keys are ever enabled, they live in VS Code `SecretStorage` or Electron `safeStorage`, never in the repo or `.codecoach/`. The Claude Code transport runs its child process with `ANTHROPIC_API_KEY` removed, so it can't fall back to billing an API key.
- **Usage controls:**
  - A per-session meter in the UI: tokens and turns, plus any rate-limit or usage-limit messages the runtime reports (subscriptions have no per-call price).
  - The monthly dollar cap in team config applies only to API-key providers.
  - Cheap sub-tasks (log summarization, response-checker rewrites, chunk triage) go to a smaller model where the transport allows choosing one.
- **Student-facing subscription adapters (stage 6), each behind a feature flag and a terms check:**
  - **GitHub Copilot through VS Code's official Language Model API.** This comes first: many students get Copilot free, and it's a sanctioned extension API;
  - OpenAI Codex `app-server` (JSON-RPC, built for third-party front ends, ChatGPT sign-in);
  - Gemini CLI in ACP mode;
  - Claude for students, **only** if Anthropic approves claude.ai login for CodeCoach.

## 2. Pedagogy engine (`packages/pedagogy`): the core differentiator
**Layered system prompt.** The stable layers are cached; the volatile layers are injected per turn.
1. **Mentor persona.** Warm and growth-mindset. It never uses "just", "simply", "obviously" or "easy". It praises reasoning and effort, not only correct answers, and it normalizes being stuck.
2. **Coaching rules:**
   - ask what the student has tried;
   - ask for a hypothesis before explaining;
   - give the smallest hint that unblocks the student, then escalate one step at a time: conceptual question → pointer to file or line → pseudocode → snippet, as far as the guardrail level allows;
   - link to the docs;
   - end with a check-for-understanding question.
3. **Guardrail level**, from team config:
   - **L0 Socratic:** no code beyond API signatures of at most 2 lines;
   - **L1 Hints + pseudocode;**
   - **L2 Snippets after an attempt:** at most about 8 lines, and only after the student has shown an attempt;
   - **L3 Pair programmer:** may propose diffs, which the student must review and accept.
4. **Student profile:** experience level, preferred language and reading level. Multilingual answers are an important accessibility lever.
5. **Project context:** language, WPILib year, controller, vendordeps and architecture pattern, from the project analyzer.
6. **Session state:** the current debugging phase and a summary of what the student has tried.

**Debugging state machine:**
```
describe → hypothesize → design experiment → observe (tools/logs) → refine → fix (student-written) → reflect
```
- The current phase is injected into the prompt.
- The coach may not explain a root cause before the student has offered a hypothesis.
- A "just tell me" escape hatch exists, but it still asks for one guess first. At L0 and L1 it then explains the *cause*, not the fix.

**Response checker** (enforced in code):
- Every assistant turn is checked before it is shown: lines of new code in fenced blocks (code the student already has doesn't count), diff-shaped content, and banned phrases.
- A turn that breaks the guardrail level is **never shown and never added to history**. Instead the request is retried with a corrective system note, and after two failures a cheap model rewrites the turn into hint form.
- History stays append-only.

**Tool gating.** File-write tools aren't even registered below L3. At L3 the coach can only produce a proposed diff, which the student must accept in a review UI.

## 3. FRC tools (`packages/frc`), exposed to the model as tools
- **Project analyzer:**
  - Reads `build.gradle`, `.wpilib/wpilib_preferences.json`, `vendordeps/*.json`, `pyproject.toml` / RobotPy config and the C++ `src/main/cpp` layout.
  - Detects the WPILib year, controller (roboRIO / SystemCore), language, vendor libraries (Phoenix 6, REVLib, PathPlanner, PhotonVision, AdvantageKit) and pattern (command-based, AdvantageKit IO layers, TimedRobot).
- **JDK resolver:** works out the required major version (17 for roboRIO, 25 for SystemCore), finds a matching JDK, and returns a structured mismatch diagnostic when there isn't one.
- **Code navigation:** `list_files`, `read_file`, `grep`, `outline_symbols` (WASM tree-sitter for Java, C++ and Python), and `map_robot_structure` (subsystems, commands, default commands, trigger bindings).
- **FRC lint checks**, surfaced as things to discuss, not auto-fixes:
  - duplicate CAN IDs;
  - a command missing its requirements;
  - blocking calls in `periodic`;
  - suspicious inversion or units;
  - a missing `CommandScheduler.run()`;
  - mismatched vendordep years;
  - a JDK mismatch.
- **Build/test runner:** `gradlew build` / `test` (with the resolved JDK) and `robotpy test`. Compiler and Gradle errors are parsed into structured diagnostics.
- **Simulation:** launches the sim (`simulateJava`, the C++ sim task, `robotpy sim`).
- **NT4 client:** reads live NetworkTables values from sim or the robot so experiments can be observed.
- **Log analysis:**
  - parsers for `.wpilog` (which covers AdvantageKit) and DS `.dslog` / `.dsevents`; `.hoot` files via CTRE `owlet` when it is installed;
  - query tools: list signals, stats over a window, events and anomalies, commanded vs. measured;
  - raw logs never go to the model whole.
- **Docs index:** BM25 over WPILib docs (CC BY, attributed), vendor docs where the licenses allow, and the API reference, versioned by season. `search_docs` returns cited excerpts.

## 4. VS Code extension (`apps/vscode`)
- **Chat panel:** a webview view built from `packages/ui`, with streaming, a cost or balance meter, a debugging-phase indicator, "I tried this" quick replies and a provider/privacy banner.
- **Commands:**
  - *Ask Coach about selection*;
  - *Explain this error* (a code action on Problems-panel diagnostics);
  - *Analyze log file…*;
  - *Start debugging session*;
  - *Set up CodeCoach for this team* (writes `.codecoach/config.json`).
- **Team config:** `.codecoach/config.json` is committed with the robot repo and validated against a JSON schema. It holds the guardrail level, allowed providers and models, monthly budget, language and reading level.
- **Mentor lock (optional):**
  - The guardrail level in `config.json` is signed with a key derived from a passphrase, and changing it in the UI needs that passphrase.
  - If the level was edited by hand and the signature no longer matches, the coach falls back to L0.
  - Teams without a mentor can give the passphrase to a student lead.
  - It's a deterrent, not security. Real enforcement comes only from the server-side pool in stage 9. See stage 2 §4.4.
- Must activate cleanly inside WPILib VS Code on Windows, macOS and Linux.

## 5. Sponsored token pool (`services/pool`, `apps/pool-web`): optional, built last
- **Separate from team-owned access.** A team that uses its own subscription never touches the pool: no account, no server, no proxy. Nothing in stages 0a–8 depends on it.
- **Spending gate.** The pool spends a sponsor's API credits through provider keys on the server, so it can only be built once the owner lifts the spending gate. It never spends the owner's money.
- **Flow:**
  1. At the start of the season, a mentor applies with team number, season dates, meeting schedule, number of programmers, ecosystems and an optional need statement.
  2. The service suggests an allotment: `programmers × meeting-hours/week × season weeks × tokens per student-hour`.
  3. A mediator approves, adjusts or declines it.
  4. The allotment is released in weekly tranches tied to the meeting calendar.
  5. A mentor can request a top-up.
- **Metering proxy:** the sponsor's provider keys live only on the server. The proxy authenticates the device, checks balance and pacing, forwards the request, debits the real usage to a double-entry ledger, and enforces the pedagogy prompt and guardrail level server-side.
- **Identity:** mentors sign in with a magic link; students join with a team join code and get revocable device tokens and a nickname. No student emails are collected.
- **Stack:** TypeScript (Hono) + Postgres in one container, which a sponsor could self-host.

## 6. Privacy and safety (students are often minors)
- **No telemetry by default.** Conversations are stored locally only. Feedback for the evals is opt-in and anonymized.
- **Provider transparency:** the UI always says which provider receives the student's code.
- **Secret check:** a scanner warns before text that looks like a secret (API keys, `.env` content) leaves the machine.
- **On-topic:** the coach politely redirects away from non-robotics topics. It never asks for personal information.
- **Files the coach reads:** only inside the open workspace, never outside it, and `.codecoach/`, `.env*` and key files are excluded.

## 7. Development environment and build systems
**The repo itself contains no Nix files.**

1. **This machine (NixOS):** `~/Documents/NixHub/dev/FRC/CodeCoach/flake.nix`, done in stage 0a.
   - **Conventions:** follows `dev/Personal/Claude_Code_History_Viewer/flake.nix` and `dev/FRC/FRC_190/Robot_Code/flake.nix`: `nixos-unstable`, `forEachSystem`, `allowUnfree`, `../../lib/shell-banner.nix`. `lib/dev-flake-aliases.nix` provides the `CodeCoach` alias automatically.
   - **Shell:** `nodejs_22`, `pnpm` (12.9.0), `jdk17` + `jdk25` side by side, `python3`, and nixpkgs `electron`.
   - **Environment:** `JAVA_HOME_17`, `JAVA_HOME_25`, `JAVA_HOME` (defaulting to 17), `GRADLE_OPTS` (rich console), `ELECTRON_SKIP_BINARY_DOWNLOAD`, `ELECTRON_OVERRIDE_DIST_PATH`, and `CODECOACH_VSCODE_EXECUTABLE` (the system VS Code).
   - **shellHook:** prints the banner, auto-runs `pnpm install` when the lockfile is newer, and lists the common commands.
   - Postgres is added at stage 9. Nothing is committed in NixHub unless you ask.
2. **Every other machine:**
   - **Pins:** `.node-version` (22), `engines.node >=22`, and `"packageManager": "pnpm@12.9.0"` via corepack.
   - **Commands** are plain pnpm scripts, with Node `.mjs` helpers for anything multi-step (no `just`, `make` or bash), so Windows works without WSL.
   - **No native addons:** WASM tree-sitter, `SecretStorage` / `safeStorage`, and pure-TypeScript parsers.
   - **External tools** (JDK 17/25, Python + robotpy, `owlet`) are detected, not required. `pnpm run doctor` reports them, and tests that need them are skipped with a clear message.
3. **CI:** GitHub Actions on ubuntu, windows and macos, with `setup-node` + corepack + `setup-java` (17 and 25). This matrix is the proof that the non-Nix path works.

### `.gitignore` additions
- **Node:** `node_modules/`, `dist/`, `out/`, `*.tsbuildinfo`, `.turbo/`, `coverage/`.
- **VS Code:** `apps/vscode/*.vsix`, `.vscode-test/`.
- **Fixtures:** `fixtures/**/build/`, `fixtures/**/.gradle/`, `fixtures/**/.venv/`, `fixtures/**/__pycache__/`.
- **Evals:** `packages/evals/runs/` (transcripts can contain fixture code and use up subscription limits to regenerate; keep them local).
- **Secrets:** `.env*`, `*.pem`, `*.key`.
- **OS/editor:** `.DS_Store`, `.vscode/*` with `!.vscode/extensions.json`, `!.vscode/launch.json`.

### `README.md`
Sections:
1. What CodeCoach is and why it exists.
2. The coaching principles.
3. Supported ecosystems.
4. Installing the extension.
5. Setting up a team (keys, guardrails).
6. Development setup (`corepack enable && pnpm install && pnpm run doctor && pnpm build`).
7. Roadmap and status.
8. License.

The README does not mention Nix.

## Milestones
| # | Milestone | Done when |
|---|---|---|
| [0a](stages/00a-dev-environment.md) | Dev environment: NixHub flake, toolchain pins, `pnpm run doctor`, README, .gitignore, `docs/dev-setup.md` | `pnpm run doctor` passes in the Nix shell and on CI's three OSes; both JDKs are detected |
| [0b](stages/00b-scaffolding-ci.md) | Scaffolding: workspace packages, TS project refs, lint/test, fixture skeletons, CI matrix | CI is green on ubuntu, windows and macos |
| [1](stages/01-core-and-pedagogy.md) | Core agent loop + Anthropic provider (API key, off by default) + read-only code tools + project analyzer + JDK resolver + pedagogy v1 + `codecoach` CLI + eval suite v1 | Built and tested offline; its live criteria are met through 1b |
| [1b](stages/01b-subscription-transport.md) | Claude Code subscription transport (development-only), MCP server, runtime supervisor, spending gate | The CLI coaches a student through the default-command-bug fixture without handing over the fix, on the owner's subscription; eval v1 baseline is recorded through it; nothing spends API money by default |
| [2](stages/02-vscode-extension.md) | VS Code extension MVP: chat panel, build-error explain, team config, guardrail levels, response checker, mentor lock | A student in WPILib VS Code fixes a planted build error and a planted logic bug with the coach; L0 violation rate is 0 on the eval suite |
| [3](stages/03-multi-provider.md) | **Deferred:** OpenAI and Google API-key providers; only if the owner lifts the spending gate | All three API providers pass the eval bar; switching providers mid-session works |
| [4](stages/04-logs-sim-nt.md) | Log analysis (wpilog/AdvantageKit, DS logs, hoot), sim launch, NT4 client | The coach finds a planted brownout and a PID oscillation *with* the student, from real log files |
| [5](stages/05-docs-index-and-lints.md) | Docs index + `search_docs`, FRC lint checks, deeper C++/RobotPy support | Answers cite season-correct docs; each lint fires on its fixture and not on clean projects |
| [6](stages/06-subscription-adapters.md) | Student-facing subscription adapters (Copilot via `vscode.lm` first, then Codex and Gemini CLI; Claude only if approved), each gated on a terms check. **Comes right after 2** | Each enabled adapter passes the eval bar through CodeCoach's own UI |
| [7](stages/07-desktop-app.md) | Electron desktop app reusing core + UI | Installers for all three OSes coach a student through a fixture with no VS Code installed |
| [8](stages/08-pilot-and-i18n.md) | Pilot with 3–5 under-resourced teams; i18n; onboarding | Pilot feedback collected; Spanish UI and coaching pass evals; onboarding finished by first-time students unaided |
| [9](stages/09-sponsor-pool.md) | Sponsor pool: ledger, metering proxy, pacing, application and mediator web app. Needs the spending gate lifted (sponsor money, not the owner's) | End to end: apply → approve → student joins → coach chat debits the shown balance; ledger invariants hold |

## Evals (built in stage 1, run on every prompt change)
- **Scenario fixtures:** small robot projects in `fixtures/`, each with a planted bug, a scripted simulated student (persona, misconceptions, what they'll try), and the expected diagnosis.
- **Starting set:**
  - default command never set;
  - requirement conflict cancels a command;
  - inverted motor;
  - degrees vs. radians;
  - duplicate CAN ID;
  - `Thread.sleep` in `periodic`;
  - wrong JDK for SystemCore;
  - PID oscillation (in a wpilog);
  - brownout (in a DS log);
  - RobotPy indentation bug;
  - C++ missing `override`.
- **Transport:** evals run through the Claude Code subscription transport (stage 1b): coach, simulated student and judge. Runs are sized to the subscription's usage windows (smoke subset first, full runs spread out), and results are tagged with the transport so later runs on other transports aren't compared blindly.
- **LLM-judge rubric** (Opus as judge, with a small human-graded calibration set):
  - (a) no solution beyond the guardrail level;
  - (b) asked for a hypothesis before explaining;
  - (c) correct technical diagnosis;
  - (d) encouraging tone, with no condescending phrases;
  - (e) pointed to relevant docs or tools;
  - (f) the student actually reached the fix.
- **Deterministic checks** run alongside the judge: the response checker, banned phrases, and whether tool calls stayed inside the workspace.
- **Output:** a score matrix per transport, provider and model. CI never runs live evals (no key, no subscription); the owner runs them locally on demand.

## Verification
- **Unit tests (vitest):** analyzer, JDK resolver, parsers (Gradle errors, wpilog, dslog), response checker, guardrail engine, prompt assembly, config schema.
- **Fixture builds:** roboRIO fixtures build on JDK 17 and SystemCore fixtures on JDK 25, in CI and in the Nix shell.
- **CLI:** `pnpm codecoach chat --project fixtures/java-default-command-bug` for manual end-to-end runs per provider.
- **Evals:** the score matrix per provider, with an L0 guardrail-violation rate of 0.
- **Extension:** `@vscode/test-electron` on the CI matrix; a manual smoke test in WPILib VS Code with a real project, sim and match log.
- **Privacy:** a network capture shows traffic only to the selected provider; the secret scanner catches seeded test secrets.

## First step after approval
Finish 0a: the toolchain pins, `pnpm run doctor`, README, `.gitignore` and `docs/dev-setup.md`. The NixHub flake is already written, verified and committed in NixHub. Then 0b scaffolds the workspace and CI.
