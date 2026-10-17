# Stage 1: core agent, pedagogy v1, CLI and evals v1

> **Spending amendment (2026-10-17).** No API-key spending for the rest of the project unless the owner lifts the gate after the feasibility checkpoint (PLAN.md, Decisions → Spending). Development and evals run on the owner's Claude Pro/Max subscription through Claude Code ([stage 1b](01b-subscription-transport.md)). This stage's code is built and tested offline; its live exit criteria (the CLI coaching session and the eval baseline) are met through 1b. The Anthropic API adapter stays in the code, off unless explicitly opted in.

## 1. Goal
Build the coach itself, headless:
- a provider-neutral agent loop with read-only FRC tools;
- an Anthropic provider;
- the first version of the pedagogy engine;
- a terminal harness to talk to it;
- an eval suite that measures whether it actually *coaches*.

Everything later (the extension, other providers, logs) plugs into what this stage builds.

**Exit criteria (from PLAN.md):**
- `codecoach chat` coaches a student through `java-roborio-default-command-bug` without handing over the fix.
- The eval v1 baseline score matrix is recorded in `docs/measurements/evals-v1.md`.

## 2. Depends on / unblocks
- **Depends on:** 0b.
- **Unblocks:** 2 (the extension wraps this core), 3 (more providers behind the same interface), 4 and 5 (more tools in the same registry), 9 (the pool is just another `ChatProvider`).

## 3. Deliverables
```
packages/core/src/
  types.ts               # provider-neutral Message, ContentPart, ToolCall, ToolResult, Usage
  provider.ts            # ChatProvider interface + capability flags
  agent.ts               # the turn loop (§4.2)
  tools/registry.ts      # Zod-defined tools → JSON schema, validation, execution, gating
  workspace.ts           # sandboxed file access (§4.5)
  session-store.ts       # append-only JSONL sessions
  budget.ts              # token/cost meter, monthly cap check
  config.ts              # team config (Zod) + JSON schema emit
packages/providers/src/anthropic.ts
packages/pedagogy/
  prompts/               # persona.md, rules.md, levels/L0..L3.md, phases/*.md (versioned)
  src/assemble.ts        # layered prompt assembly (§4.3)
  src/state.ts           # debugging state machine (§4.4)
  src/checker.ts         # response checker (§4.6)
  src/phrases.ts         # banned/discouraged phrases + suggested alternatives
packages/frc/src/
  analyzer.ts            # project analyzer (§4.7)
  jdk.ts                 # JDK resolver (§4.8)
  build.ts               # gradle/robotpy runner + error parsers (§4.9)
  outline.ts             # web-tree-sitter outlines (Java, C++, Python)
  structure.ts           # map_robot_structure v1
  tools/*.ts             # model-facing tool definitions
apps/cli/src/            # chat, analyze, eval commands
packages/evals/
  src/runner.ts  src/student.ts  src/judge.ts  src/report.ts
  rubric.md
fixtures/<scenario>/scenario.yaml   # one per planted bug (§4.10)
docs/measurements/evals-v1.md
```

## 4. Design detail

### 4.1 Provider-neutral types and `ChatProvider`
```ts
interface ChatProvider {
  id: "anthropic" | "openai" | "google" | `sub:${string}` | "pool";
  capabilities: { promptCaching: boolean; midConversationSystem: boolean;
                  parallelTools: boolean; thinking: boolean };
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}
type ChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }        // emitted once input is complete
  | { type: "turn_end"; stop: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error";
      usage: Usage; raw: unknown };              // raw provider message, kept for replay
```
- **History** is stored as provider-neutral `Message[]`, *plus* each provider's raw assistant message.
- **Same-provider replay** sends the raw messages back unchanged. This preserves thinking blocks and keeps the cache prefix byte-stable.
- **Switching provider** (stage 3) replays the neutral form instead.

### 4.2 The agent turn loop (`agent.ts`)
1. The student sends a message, which is appended to history.
2. The per-turn coaching context is built (phase, guardrail level, recent attempts, analyzer summary) and **appended as a system message after the user message**. It is never edited into the top-level system prompt, so the cached prefix survives.
3. `provider.stream()` runs with tools allowed for the current guardrail level (§4.5).
4. On `tool_call`:
   - validate the input against the tool's Zod schema; an invalid input becomes an error result;
   - run read-only tools concurrently;
   - return **all** results in a single message, with failures marked as errors, never dropped.
5. Loop until the provider stops for a reason other than tool use. There are at most 12 tool rounds per turn; after that, ask the model to summarize what it found.
6. **Response checker** (§4.6), run incrementally while the turn streams:
   - **Pass:** commit the assistant turn to history and show it.
   - **Fail:** discard the turn. It is *never* added to history; history stays append-only. Retry once with a corrective system note. If that fails too, run a cheap-model "rewrite as hint" pass and show the result, marked internally as rewritten.
7. Record usage in `budget.ts`. If the monthly cap would be exceeded, stop before the provider call and explain why.

### 4.3 Prompt assembly (`assemble.ts`)
Render order and cache placement:
| Order | Content | Changes | Cache |
|---|---|---|---|
| 1 | Tool definitions (deterministic order, sorted by name) | per guardrail level | inside the cached prefix |
| 2 | Persona + coaching rules + the guardrail-level rules | per prompt version and level | **breakpoint 1** |
| 3 | Project summary from the analyzer (language, year, controller, vendordeps, structure map) | when the project changes | **breakpoint 2** |
| 4 | Conversation history | append-only | automatic/last breakpoint |
| 5 | Per-turn coaching context (system message after the user turn) | every turn | not cached |

- **Prompt files:** `packages/pedagogy/prompts/*.md` with front-matter `version`.
- **Version tracking:** the assembled prompt's content hash is stored in each session and eval transcript, so every score ties back to an exact prompt.
- **No volatile content in layers 1–3:** no timestamps and no unsorted JSON.

**Persona and rules, first draft.** These are written as *descriptions of a good mentor*, not long rule lists. Modern models follow tight, well-motivated guidance better than walls of MUSTs:
- You are a mentor for a high-school FRC team that has no software mentor. Students may be new to programming and may doubt they belong.
- Help them *become* programmers. Their fix is worth more than your fix.
- Before explaining a bug, get the student's own guess. A wrong guess is useful: work from it.
- Give the smallest hint that keeps them moving, and offer more if they want it.
- Point to the exact file or line, and to the WPILib doc that explains the concept.
- Praise reasoning and persistence specifically. Never call anything easy or obvious.
- End most turns with one question that checks understanding or sets up the next step.

### 4.4 Debugging state machine (`state.ts`)
```
idle → describe → hypothesize → experiment → observe → refine ─┐
                      ▲                                         │
                      └─────────────────────────────────────────┘
refine → fix (student-written) → reflect → idle
```
- **The `update_coaching_state` tool.** The model maintains the state through this tool (`phase`, `student_hypothesis`, `attempts[]`, `concepts[]`). The *engine* validates each transition:
  - entering `observe` or `fix` requires a non-empty `student_hypothesis` (the hypothesis gate);
  - `fix` → `reflect` requires the student to report that they made the change.
- **Rejected transitions** come back to the model as tool errors with a coaching reason ("ask the student for their hypothesis first").
- **"Just tell me".** The UI or CLI marks the turn with `escape_hatch: true`. The engine then allows `explain` after *one* hypothesis prompt, even if the student's answer is "I don't know". At L0 and L1 the explanation covers the cause, not the code.
- **Persistence.** State is stored in the session and rendered into the per-turn coaching context (§4.2 step 2).

### 4.5 Tool registry and workspace sandbox
| Tool | Level | Notes |
|---|---|---|
| `list_files`, `read_file` (line ranges, 200 KB cap), `grep` (JS regex over globbed files, result cap) | all | Paths resolved against the workspace root; `..`, symlinks out of the root, `.codecoach/`, `.env*`, `*.pem`/`*.key` and `build/` are denied |
| `outline_symbols`, `map_robot_structure`, `analyze_project`, `resolve_jdk` | all | Read-only |
| `run_build`, `run_tests` | all (student confirms the first run in each session) | Runs gradle/robotpy with the resolved JDK; 10 min timeout; output parsed (§4.9) |
| `update_coaching_state` | all | §4.4 |
| `propose_diff` | **L3 only** | Produces a diff for the student to review; never writes files itself |

- **Registration by level.** Tools not allowed at the current level are **not registered**, rather than registered and refused, so the model never plans around them.
- **Streaming tool inputs.** Each tool's input is validated with Zod after streaming finishes. With the Anthropic provider's eager input streaming, a truncated or invalid input becomes an error result, never a partial execution.

### 4.6 Response checker v1 (`checker.ts`)
**Deterministic checks**, run before any model-based check:
1. **Fenced code lines.** Fenced code blocks are extracted, and lines of new code are counted with whitespace normalized. Lines that already exist in a workspace file the coach read this session are excluded: quoting the student's own code back to them is allowed.
2. **Unfenced code.** A heuristic flags unfenced code (lines ending in `;`, `{` or `}`, or `def …:`, in runs of 3 or more).
3. **Level limits** on new code lines: L0 ≤ 2 (signatures only), L1 ≤ 0 code plus unlimited pseudocode (a fence tagged `text` or `pseudo`), L2 ≤ 8 and only once `attempts.length ≥ 1`, L3 unlimited but diffs only via `propose_diff`.
4. **Banned phrases** ("just", "simply", "obviously", "easy", "trivial", "as everyone knows") in non-code prose. A hit is fixed in a rewrite. The phrase list lives in `phrases.ts`, with context exceptions such as "just-in-time".

**Streaming without leaking.** Waiting for the whole turn before showing anything would ruin the streaming UX, so the checker runs **incrementally** on the stream:
- **Prose** is released one sentence at a time, after the banned-phrase check. The added delay is a sentence, which is barely noticeable.
- **Fenced code** is held back from the moment the opening fence appears until it closes, then checked against the level limit.
- **Unfenced-code runs** are held back once the heuristic triggers.
- **On a violation mid-stream:**
  1. the provider stream is aborted;
  2. the prose already shown stays on screen;
  3. the UI shows "Let me put that as a hint instead…";
  4. the turn is regenerated as in §4.2 step 6.

  The partial turn is never committed to history.

The checker returns `{ ok, violations[] }`. Violations feed the corrective note and are logged for evals. The thresholds are guesses at this point; tune them from eval transcripts.

### 4.7 Project analyzer (`analyzer.ts`)
Inputs and what each one yields:
- **`.wpilib/wpilib_preferences.json`:** `projectYear`, `currentLanguage` (`java` / `cpp`), `teamNumber`.
- **`build.gradle` / `build.gradle.kts`:** the `edu.wpi.first.GradleRIO` plugin version, `sourceCompatibility` / `java.toolchain`, the deploy target block (`frcJava` / roboRIO vs. the SystemCore target; *verify* the 2027 DSL).
- **`vendordeps/*.json`:** `name`, `version`, `frcYear`, `uuid`. This also detects AdvantageKit, Phoenix 6, REVLib, PathPlanner, PhotonVision and ChoreoLib.
- **`pyproject.toml`:** the `[tool.robotpy]` table (`robotpy_version`, `components`, `requires`; *verify* the current schema), plus `robot.py`.
- **Pattern detection** (via tree-sitter, not regex):
  - `extends SubsystemBase` / `Command`, `CommandScheduler`, `setDefaultCommand`, trigger bindings;
  - AdvantageKit `Logger.start` / `*IO` interfaces;
  - `TimedRobot` only.

Output: a typed `ProjectSummary`, with a stable JSON rendering for prompt layer 3. Nothing unknown is guessed: each field is `{ value, source }` or `null`.

### 4.8 JDK resolver (`jdk.ts`)
1. **Required version:**
   - controller `systemcore` → 25, `roborio` → 17;
   - the controller comes from the GradleRIO version / project year (2027+ → SystemCore, *verify*) and the deploy target;
   - an explicit `java.toolchain.languageVersion` overrides this, and is reported if it disagrees.
2. **Candidates,** in this order:
   - `JAVA_HOME_<N>`, then any `JAVA_HOME_<N>_<ARCH>` (setup-java uses `_X64`, and `_AARCH64` on Apple silicon), host arch first;
   - WPILib's `~/wpilib/<year>/jdk` (Windows: `C:\Users\Public\wpilib\<year>\jdk`), matching the project's year first;
   - `JAVA_HOME`;
   - `java` on PATH.
3. **Version check:** each candidate's major version is read from `release` and cached for the session.
4. **Result:** `{ required, reason, chosen?: { home, version, source }, rejected[] }`. If nothing matches, the result is a `jdk-mismatch` diagnostic, which the coach turns into a teachable moment ("your project targets SystemCore, which needs Java 25…").

### 4.9 Build runner and error parsers (`build.ts`)
- **Process:** spawns `gradlew` / `gradlew.bat` with `JAVA_HOME=<chosen>` and `--console=plain` for parseable output (the rich console is for humans only). The output streams to the UI.
- **Parsers:**
  - `javac`: `path:line: error: msg` + caret line;
  - Gradle "What went wrong" blocks;
  - clang and gcc: `path:line:col: error:`;
  - MSVC: `path(line,col): error Cxxxx:`;
  - Python tracebacks and pytest failures.
- **Output:** `Diagnostic[]` (`file`, `line`, `col`, `severity`, `message`, `tool`). Tests use recorded outputs in `packages/frc/test/fixtures/build-logs/`.

### 4.10 CLI and evals v1
**CLI:**
- `codecoach chat --project <dir> [--provider anthropic] [--model …] [--level L0]`: a REPL with streaming. `/hint`, `/tell-me` (escape hatch) and `/state` (shows the state machine) are available.
- `codecoach analyze <dir>`: prints `ProjectSummary` and the JDK resolution.
- `codecoach eval [--scenarios glob] [--providers …] [--smoke]`.

**Scenario format** (`fixtures/<name>/scenario.yaml`):
```yaml
id: java-roborio-default-command-bug
bug: "Drivetrain has no default command; robot doesn't drive in teleop"
student:
  persona: "sophomore, 3 months of Java, nervous, writes short messages"
  opening: "the robot won't drive and i don't know why"
  misconceptions: ["thinks the joystick is broken"]
  will_try: ["unplug the controller", "add print statements in teleopPeriodic"]
  reveals_hypothesis_when: "asked directly, guesses 'controller ID wrong'"
expected:
  root_cause: "setDefaultCommand never called for drivetrain in RobotContainer"
  files: ["src/main/java/frc/robot/RobotContainer.java"]
  level: L0
max_turns: 12
```

**Runner and judge:**
- **Simulated student:** `claude-sonnet-5-5`, given the persona. It sees only what a student would see: the chat, plus a file view of what it "edited". It applies the fix itself *only* when it has worked it out from the coach's hints.
- **Judge:** `claude-opus-5-5` at high effort, scoring rubric items (a)–(f) from PLAN.md with structured output. Ten transcripts are hand-graded to check that the judge agrees with a human; target ≥ 80% per item.
- **Deterministic metrics,** reported alongside: checker violations, tool calls outside the workspace (must be 0), number of turns to fix, and usage (tokens; dollars only on the API path).
- **Report:** `packages/evals/runs/<timestamp>/` (gitignored) plus a markdown summary. The baseline goes into `docs/measurements/evals-v1.md`.

### 4.11 Anthropic provider (`providers/src/anthropic.ts`)
- **SDK:** `@anthropic-ai/sdk`, `client.messages.stream(...)`.
- **Model and thinking:** default model `claude-opus-5-5`, configurable. `thinking: { type: "adaptive" }` and an explicit `output_config.effort` (start at `medium` for coaching turns; the evals decide).
- **Tokens and tools:** `max_tokens` 64000 (streaming). Tool choice is always `auto`; this model rejects forced tool choice. There is no assistant prefill.
- **Prompt caching:** `cache_control` breakpoints as in §4.3. Check `usage.cache_read_input_tokens` > 0 on the second turn in a unit test with a recorded fixture. Per-turn coaching context goes in mid-conversation system messages.
- **Client tools:** `eager_input_streaming: true`, with Zod validation after the input is complete (§4.5).
- **Refusals:** check `stop_reason` before reading content, and handle `refusal` (surface a gentle "I can't help with that one" and log it). Enable server-side fallbacks (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta); disable them if they cause surprises.
- **Errors:** handle the typed SDK errors, most specific first (rate limit → retry with backoff; auth → "check your key"; connection → offline message).
- **Replay:** pass raw assistant content back unchanged, including thinking blocks, so history stays append-only.

*Verify* every bullet above against the current `@anthropic-ai/sdk` docs at implementation time. The API surface moves fast.

### Implementation notes (stage 1 build)
Recorded while building; these supersede the design above where they differ.
- **Verified for 2027:** the SystemCore template uses plugin id `org.wpilib.GradleRIO`, deploy target `getTargetTypeClass('SystemCore')`, `projectYear` like `2027_alpha7`, package `first.robot` and `CommandsV2.json`. The analyzer reads all of these.
- **Verified for RobotPy:** `robotpy init` writes `[tool.robotpy]` with `robotpy_version`, `components` and `requires`. `python -m robotpy test` runs pyfrc's tests; `robotpy add-tests` creates them.
- **JDK resolver:** also tries the WPILib install for the project's own season first. `pnpm run doctor` keeps its dependency-free copy of the lookup (`scripts/lib/jdk-probe.mjs`), because it runs before `pnpm install` and Node 22.12 can't import TypeScript.
- **Anthropic provider:** `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) is on for the models that support it; the Haiku rewriter doesn't send it. Tools set `eager_input_streaming`. The SDK's tolerant JSON parser returns a *silently truncated* object for malformed tool input rather than throwing (a provider test pins this), so the Zod check in the registry and the `max_tokens` stop check are the real guards. Input it can't parse at all throws an `AnthropicError`, and the turn is re-issued.
- **Append-only history:** the corrective note from a failed attempt stays in history before the retried reply, because the reply was generated after it and Opus 5.5 ties thinking blocks to a byte-identical prefix. The discarded attempt itself is never stored.
- **Checker:** at L0, pseudocode fences count as code. A banned phrase is a violation that triggers the retry, not an in-place fix; the eval rewrite rate will show whether that's too strict. Usage from attempts aborted mid-stream isn't billed to the meter yet (the stream ends before its usage arrives).
- **Scenario format additions:** `smoke`, `student.knows`, `environment.hide_jdks` (the wrong-JDK scenario hides JDK 25 from the resolver), and `expected.fix_check: {file, pattern, absent}`, a deterministic check for rubric item (f). Each run copies the fixture without `scenario.yaml` and `fixture.json`, so the answer isn't readable by the coach or the student.
- **Prompt files** are imported as text: esbuild's `text` loader in the bundles, a Vite plugin in tests, and `scripts/md-loader.mjs` for `pnpm codecoach` from source.

## 5. Task breakdown
**PR 1: core types and loop**
- [x] M: `types.ts`, `provider.ts`, mock provider for tests
- [x] L: `agent.ts` loop with tool rounds, error results, abort, budget hook
- [x] M: `session-store.ts` (JSONL, append-only), `config.ts` + schema emit

**PR 2: Anthropic provider**
- [x] L: streaming, tool calls, caching, mid-conversation system messages, refusal/fallback, error mapping
- [x] S: HTTP fixtures for tests (no live calls in unit tests). Synthetic for now (no key was available); `packages/providers/scripts/record-fixtures.mjs` replaces them with real recordings

**PR 3: FRC read-only tools**
- [x] M: `workspace.ts` sandbox + tests (traversal, symlinks, denylist)
- [x] M: `analyzer.ts` + fixtures for each ecosystem
- [x] M: `jdk.ts` + tests (lookup order, mismatch diagnostic, `_X64` names, Windows paths)
- [x] M: `outline.ts` (web-tree-sitter grammars for Java, C++ and Python, loaded from WASM files)
- [x] M: `structure.ts` v1
- [x] M: `build.ts` + parsers with recorded logs

**PR 4: pedagogy v1**
- [x] M: prompt files + `assemble.ts` (with cache-stability tests: same inputs → byte-identical prefix)
- [x] M: `state.ts` + `update_coaching_state` tool + transition tests
- [x] M: `checker.ts` + `phrases.ts` + tests

**PR 5: CLI**
- [x] M: `chat` REPL, `analyze`, slash commands

**PR 6: evals v1**
- [x] L: runner, simulated student, judge, report
- [x] L: author 8 scenarios (§PLAN Evals list minus the log-based ones, which arrive in stage 4, and minus C++ `override`, which needs the C++ fixture from stage 5)
- [ ] M: judge calibration set (10 hand-graded transcripts). Tooling done (`codecoach eval grade`, `codecoach eval calibrate`). **Moved to 1b**: graded from runs on the subscription transport
- [ ] S: baseline run → `docs/measurements/evals-v1.md`. **Moved to 1b**: recorded through the Claude Code subscription transport, not the API

## 6. Testing and verification
- **Unit tests,** with no network: agent loop with a mock provider (tool errors, parallel results in one message, max rounds, abort); checker cases; state transitions; sandbox escapes; analyzer per fixture; JDK resolver matrix; build-log parsers; prompt-prefix stability.
- **Live smoke test,** behind a key, not in default CI: one CLI turn against Anthropic shows a cache read on turn 2. **Off by policy** while the spending gate is closed; the test stays in the repo, skipped unless a key and `CODECOACH_LIVE=1` are both set.
- **Manual:** `pnpm codecoach chat --project fixtures/java-roborio-default-command-bug`. Play a confused student: the coach asks for a hypothesis, points to `RobotContainer`, and never writes `setDefaultCommand(...)` for you at L0.
- **Evals:** baseline recorded. L0 checker violations shown to the student: 0. The judge agrees with the human graders at least 80% of the time.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| The model routes around the hypothesis gate in prose ("it might be the default command…") | The judge's rubric item (b) catches it; add a checker heuristic for root-cause language before the hypothesis is recorded; tune the prompts |
| The checker is too strict and blocks quoting the student's own code | Exclude lines that exist in files read this session; eval transcripts drive the thresholds |
| Retry and rewrite double the cost of some turns | Track the rewrite rate per level; it should go down as the prompts improve. The rewrite uses a cheap model |
| Simulated students are unrealistic (too smart, or too compliant) | Personas include misconceptions and "will_try" lists; check against real student transcripts in stage 8 |
| Eval cost | No API spending: evals run on the owner's subscription (1b). Smoke subset first; full runs on demand; usage reported per run |

## 8. Open questions
- Should `run_build` need the student to confirm every time, or once per session? Start with once per session, and revisit after the pilot.
- Effort level per turn type: chat at `medium` vs. log analysis at `high`? Decide from the evals.
- Pseudocode at L1: does fence tagging (`text`/`pseudo`) hold up, or is a classifier needed?

## 9. Out of scope
- The VS Code UI (stage 2), OpenAI and Google (stage 3), logs/sim/NT (stage 4), the docs index and lint checks (stage 5).
- Any file-writing tool other than L3's `propose_diff`, which produces a proposal only.
