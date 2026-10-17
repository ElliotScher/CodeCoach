# Stage 1b: subscription transport and spending gate

## 1. Goal
Run the coach, the CLI and the evals on the project owner's **Claude Pro/Max subscription**, through Claude Code in headless mode, so the project's feasibility can be proven without paying for API usage. At the same time, make sure **no code path spends API money by default**, for every provider.

This transport is **development-only**. It is never shipped to students: Anthropic doesn't allow third-party products to offer claude.ai login without prior approval ([Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview)). The owner running their own Claude Code on their own machine to build and evaluate CodeCoach is a different case from distributing claude.ai login to students; §4.6 records the terms check.

**Exit criteria** (these replace stage 1's live criteria):
- `codecoach chat --project fixtures/java-roborio-default-command-bug` (default transport `claude-code`) coaches a student through the bug without handing over the fix, using CodeCoach's tools, prompt and checker, with Claude Code's built-in tools disabled.
- The eval v1 baseline (coach, simulated student and judge) is recorded through this transport in `docs/measurements/evals-v1.md`.
- No command spends API money unless explicitly opted in, and CI needs no key.

## 2. Depends on / unblocks
- **Depends on:** 1 (agent loop, tool registry, pedagogy, checker, evals).
- **Unblocks:**
  - 2: the extension's development provider;
  - 6: the MCP server and runtime supervisor move here from stage 6, and the student-facing adapters reuse them;
  - the feasibility checkpoint: once stages 1–2 meet their exit criteria through subscriptions, the owner decides whether the spending gate ever lifts.

## 3. Deliverables
```
packages/mcp-server/                       # the tool registry over MCP (stdio), level-aware (moved from stage 6)
packages/providers/src/subscriptions/
  runtime.ts                               # spawn/supervise child runtimes, detect installs and versions (moved from stage 6)
  claude-code.ts                           # ChatProvider over `claude -p` stream-json (development-only)
packages/providers/src/spend-gate.ts       # API-key adapters refuse unless opted in
apps/cli: --provider claude-code (default), --allow-api-spend for the API adapter
packages/evals: student and judge through the same transport; results tagged with the transport
docs/policy/subscriptions.md               # terms check, starting with the Claude development entry (§4.6)
scripts/doctor.mjs                         # reports Claude Code (installed, version) instead of API keys
```

## 4. Design detail

### 4.1 Spending gate
- **Default off.** Every API-key adapter (the stage 1 Anthropic adapter, and stage 3's OpenAI and Google adapters if they're ever built) refuses to construct unless spending is opted in, with `--allow-api-spend` on the CLI or `CODECOACH_ALLOW_API_SPEND=1`. The refusal names the subscription alternative.
- **The UI** (stage 2) hides API-key setup behind an experimental setting until the gate lifts.
- **Tests and CI** keep using mocked or recorded streams. The existing live API test stays gated (it needs a key *and* `CODECOACH_LIVE=1`) and is documented as off by policy.
- **Lifting the gate** is a deliberate decision by the project owner after the feasibility checkpoint, recorded in PLAN.md's decisions table. Nothing lifts it automatically.

### 4.2 Claude Code transport (`claude-code.ts`)
Flags marked *verify* are checked against `claude --help` and the [headless docs](https://docs.claude.com/en/docs/claude-code/headless) at implementation time.
- **Process:** spawn `claude -p --output-format stream-json --input-format stream-json --verbose` (*verify*). Keep one process per coaching session, so later turns go to the same conversation (or resume with `--resume <session_id>`; *verify* which works better).
- **Sign-in:** the owner signs in to Claude Code once, interactively, with their Pro/Max account. The adapter checks the sign-in status at startup and explains how to sign in if needed. CodeCoach never reads or stores Claude Code's tokens.
- **No silent API billing:** the child process is started with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed from its environment, so Claude Code can't fall back to an API key. The adapter also checks that the run reports subscription authentication (*verify* how the init event reports it) and refuses otherwise.
- **System prompt:** the pedagogy layers go in through `--system-prompt` if it replaces Claude Code's own prompt, or `--append-system-prompt` otherwise (*verify*). A canary instruction confirms the prompt took effect; the adapter refuses to run if it didn't (the pattern from stage 6 §4.2).
- **Tools:**
  - CodeCoach's registry is served by `packages/mcp-server` (stdio) and registered with `--mcp-config`;
  - only `mcp__codecoach__*` tools are allowed (`--allowedTools`), and Claude Code's built-in tools (Bash, Edit, Write, Read, WebFetch, …) are disabled (`--disallowedTools` / `--tools`; *verify*);
  - permissions are set so anything else is denied without a prompt (*verify* the permission mode or a `--permission-prompt-tool` that always denies).

  The coach must not get a second, unchecked way to read or edit the student's files. A test proves the built-ins are unavailable.
- **Model:** `--model opus` by default, configurable (`sonnet` when the subscription's usage limits are tight). Per-turn effort control depends on what the CLI exposes (*verify*).
- **Events:** stream-json messages map to `ChatEvent`s. Assistant text deltas become `text_delta`; MCP tool calls are visible as tool use and results; the final result message gives `turn_end` with token usage. Its cost field is an API-equivalent estimate, not a bill, and is shown as such.

### 4.3 What differs from the API path
| Concern | API adapter (stage 1) | Claude Code transport |
|---|---|---|
| History | CodeCoach owns it; a failed attempt is never stored | Claude Code owns the conversation. A blocked turn can't be removed, so the adapter sends a follow-up ("Rephrase your last answer as a hint, without code") and shows only that (as in stage 6 §4.2). Evals report the rate |
| Per-turn coaching context | Mid-conversation system message | Prepended to the user turn in a clearly marked block (or a supported mechanism if one exists; *verify*) |
| Caching, fallbacks, effort | Explicit (`cache_control`, `fallbacks`, `output_config.effort`) | Whatever Claude Code does internally |
| Cost | Dollars per call | Subscription usage limits; the meter shows tokens, turns and limit messages |
| Tool loop | CodeCoach's agent loop | Claude Code's loop, with CodeCoach's tools over MCP; the 12-round cap becomes `--max-turns` (*verify*) |

The streaming response checker still gates everything shown to the student.

### 4.4 Evals on the subscription
- **Coach, simulated student and judge** all run through this transport. The judge's structured output becomes a JSON instruction plus Zod validation (no `output_config.format`), with one retry on invalid JSON.
- **Usage windows:** subscriptions have rolling usage limits. The runner starts with the smoke subset, runs scenarios one at a time, backs off when the runtime reports a limit, and resumes the run later from the scenarios not yet finished.
- **Tagging:** every result records the transport and model, so a future API-path run is never compared with these numbers without saying so.

### 4.5 MCP server and runtime supervisor (moved from stage 6)
- **`packages/mcp-server`:** CodeCoach's tool registry over MCP (stdio). It is level-aware (L0 never lists `propose_diff`) and runs the same Zod validation and workspace sandbox as the in-process registry. `update_coaching_state` is included, so the state machine's gates still apply.
- **`runtime.ts`:** spawn, health check, restart, version detection, clean shutdown, and a clear message when a runtime isn't installed (no silent installs).

### 4.6 Terms check (first entry in `docs/policy/subscriptions.md`)
Record, with links and a "checked on" date:
- that the owner's use of Claude Code headless mode with their own Pro/Max subscription, for developing and evaluating their own project, is within Anthropic's current terms and usage policy (*verify*);
- how usage limits apply to `claude -p` and Agent SDK use. A secondary source says that from June 15, 2026, subscription usage of the Agent SDK and `claude -p` draws from a separate monthly credit ([Tutorials Dojo](https://tutorialsdojo.com/claude-agent-sdk/)); *verify* against Anthropic's own documentation;
- that this transport is never offered to students or other teams, and why (third-party products can't offer claude.ai login without approval).

## 5. Task breakdown
**PR 1: spending gate**
- [ ] S: `spend-gate.ts`; the Anthropic adapter, `codecoach chat` and `codecoach eval` refuse API mode without `--allow-api-spend`
- [ ] S: docs updated (dev-setup, README) so nothing suggests setting an API key

**PR 2: MCP server** (moved from stage 6)
- [ ] M: `packages/mcp-server` over the stage 1 registry, level-aware, with a conformance test

**PR 3: runtime supervisor** (moved from stage 6)
- [ ] M: `runtime.ts`

**PR 4: Claude Code transport**
- [ ] S: terms entry in `docs/policy/subscriptions.md`
- [ ] L: `claude-code.ts`: spawn, sign-in check, no-API-key environment, prompt injection + canary, MCP-only tools, event mapping, rephrase turns
- [ ] S: recorded stream-json fixtures for tests

**PR 5: CLI and evals on the subscription**
- [ ] M: `--provider claude-code` as the CLI default; `/cost` shows usage instead of dollars
- [ ] M: evals runner on the transport, with judge JSON validation, usage-limit backoff and resume, and transport tagging
- [ ] S: smoke run, then the full baseline → `docs/measurements/evals-v1.md`
- [ ] M: judge calibration set (10 hand-graded transcripts), as in stage 1

## 6. Testing and verification
- **Unit tests,** with no network and no subscription:
  - the spending gate refuses API mode by default;
  - the child environment has no API key;
  - stream-json fixtures map to the right `ChatEvent`s;
  - the canary failure path refuses to run;
  - a blocked turn produces a rephrase turn;
  - the MCP server lists the right tools per level.
- **Manual, on the owner's machine:** sign in to Claude Code with the Pro/Max account, run `codecoach chat` on the default-command fixture, and confirm the built-in tools are unavailable (ask the coach to edit a file; it can't).
- **Evals:** smoke run first; then the full baseline, spread across usage windows if needed.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Claude Code's own system prompt or behaviors fight the pedagogy prompt | Canary check, evals, a prompt delta for this transport; prefer replacing the system prompt over appending if the CLI allows it |
| Built-in tools give the coach an unchecked way to edit files | Disable them by configuration, deny all permissions, test it; refuse to run if it can't be confirmed |
| Usage limits stall eval runs | Smoke subset first, one scenario at a time, backoff and resume; `sonnet` for the student when limits are tight |
| Claude Code silently uses an API key and bills it | Strip API-key variables from the child environment; check the reported auth mode; refuse otherwise |
| Results on this transport don't carry over to the shipped transports | Tag results by transport; re-baseline on each student-facing adapter in stage 6 |
| The terms don't allow this use, or change | Terms check first (§4.6), re-checked each stage; the API adapter stays available behind the gate if the owner chooses to lift it |
| CLI flags and stream-json events change between Claude Code versions | Pin a minimum version; detect the version and refuse unsupported ones with a clear message |

## 8. Open questions
- Does the Claude Agent SDK (`query()`, in-process MCP tools, custom system prompt) work better than the raw CLI for development use with the owner's subscription? It may offer cleaner control. Decide after the terms check.
- Can the per-turn coaching context use a supported mechanism (hooks, a context file) instead of being prepended to the user turn?
- Which model gives the best results within the subscription's limits: Opus for the coach and judge, Sonnet for the student?

## 9. Out of scope
- Offering this transport to students or other teams.
- Extracting or reusing Claude Code's OAuth tokens directly.
- Student-facing subscription adapters (stage 6).
