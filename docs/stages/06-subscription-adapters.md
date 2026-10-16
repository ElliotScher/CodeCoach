# Stage 6: subscription adapters

## 1. Goal
Let someone who already pays for a consumer AI subscription (ChatGPT, Gemini, Claude) use it to power CodeCoach, **inside CodeCoach's own chat window**, with CodeCoach's tools, pedagogy and checker. The vendor's official runtime runs headlessly as the transport.

An adapter ships **only** after a written check confirms that the vendor's terms allow this kind of use, including use by minors.

**Exit criterion (from PLAN.md):** each enabled adapter passes the stage 3 eval bar through CodeCoach's own UI.

## 2. Depends on / unblocks
- **Depends on:** 1 (tool registry), 2 (UI), 3 (translation layers, eval bar).
- **Unblocks:** nothing depends on it. It widens access for teams without API budgets.

## 3. Deliverables
```
packages/mcp-server/            # CodeCoach's tool registry exposed as an MCP server (stdio)
packages/providers/src/subscriptions/
  codex.ts                      # OpenAI Codex app-server adapter (JSON-RPC over stdio)
  gemini-acp.ts                 # Gemini CLI in ACP mode
  claude-agent.ts               # Claude Agent SDK, only if approved (§4.5)
  vscode-lm.ts                  # GitHub Copilot via VS Code's Language Model API (§4.6)
  runtime.ts                    # spawn/supervise child runtimes, detect installs
docs/policy/subscriptions.md    # the terms check, per vendor, dated, with sources (§4.1)
```

## 4. Design detail

### 4.1 Terms gate: before any code ships
`docs/policy/subscriptions.md` answers these questions per vendor, with links and a "checked on" date:
1. Does the vendor allow its official CLI/runtime to be driven by a third-party front end with the user's own subscription login?
2. **Age limits.** What is the minimum age for the consumer account, and is parental consent needed? Some consumer plans are 18+ only, which would rule out most students and leave this path for adult mentors or students who are 18 or older.
3. **Account sharing.** Many terms forbid sharing one personal subscription across a team. The UI must not encourage a mentor to log every student into their own account.
4. **Data use.** Is consumer-plan content used for training by default, and can it be opted out of? This has to be shown in the privacy banner.
5. **Rate limits and fair use** that could affect a team.

An adapter's feature flag (`codecoach.experimental.subscriptions.<vendor>`) stays off and hidden until every answer is acceptable. If anything is ambiguous, the answer is to email the vendor and wait, not to ship.

### 4.2 Shared design: MCP for tools, CodeCoach owns the UI
- **Tools over MCP.** All three runtimes can call tools from MCP servers, so `packages/mcp-server` exposes CodeCoach's registry over stdio. The tools available still depend on the guardrail level, so L0 exposes no `propose_diff`.
- **Built-in tools off.** Each adapter **disables the runtime's own built-in tools that write files or run shell commands**. Any approval request that gets through is denied automatically. The coach must not get a second, unchecked way to edit the student's code.
- **Pedagogy prompt.** The pedagogy prompt is injected through each runtime's supported customization (developer/base instructions, system-prompt override, context file). The adapter checks at startup that the override took effect, using a canary instruction, and refuses to run if it didn't.
- **Display and the checker.** The runtime's streamed output becomes `ChatEvent`s, and the streaming checker (stage 1 §4.6) gates what is shown.
- **History.** The runtime owns its conversation, so a blocked turn can't be removed from it. Instead the adapter sends a follow-up turn ("Rephrase your last answer as a hint, without code") and shows only that. The student never sees the blocked turn. The eval transcripts mark these turns, so the rate is measured.

### 4.3 OpenAI Codex `app-server`
- **Transport:** spawn `codex app-server` and speak JSON-RPC over stdio. The protocol is designed for rich third-party clients such as IDE extensions (*verify* the current method names for initializing, starting a thread and turn, streaming item events, and approvals).
- **Login:** use the runtime's own ChatGPT sign-in flow (it opens the browser). CodeCoach never sees or stores the tokens.
- **Configuration:**
  - read-only sandbox;
  - approval policy: every exec and patch request declined;
  - CodeCoach's MCP server registered;
  - developer instructions = the pedagogy layers.
- **Detection:** `doctor` and the setup UI detect the `codex` binary and its version, and link to the install docs.

### 4.4 Gemini CLI (ACP)
- **Transport:** spawn the Gemini CLI in Agent Client Protocol mode (JSON-RPC over stdio; *verify* the flag, which was `--experimental-acp`).
- **Login:** the CLI's own Google sign-in.
- **Configuration:**
  - built-in write and shell tools excluded through settings;
  - CodeCoach's MCP server registered;
  - the system prompt overridden via the supported mechanism (*verify*: system-prompt file env var or context file).
- **Data warning.** Consumer Google-login usage may fall under terms that allow product improvement using the content (*verify*). The privacy banner must say so plainly, and recommend paid or education access for students.

### 4.5 Claude (Agent SDK)
- **Policy.** Anthropic currently does not allow third-party products to offer claude.ai subscription login without prior approval. This adapter is built **only if** Anthropic grants approval for CodeCoach. Otherwise Claude stays API-key only, which stage 1 already supports.
- **If approved:** `@anthropic-ai/claude-agent-sdk` `query()`, with:
  - a custom system prompt;
  - built-in edit, write and bash tools disallowed;
  - CodeCoach's tools from an in-process SDK MCP server;
  - a permission mode that denies everything else.
- **Age limits.** claude.ai consumer accounts have an age minimum (*verify*), so this path would be mentor-only for most teams.

### 4.6 GitHub Copilot via the VS Code Language Model API (VS Code only)
This may be the **most equitable** subscription path. Many students can get Copilot at no cost through GitHub's education benefits (*verify* the current eligibility). VS Code's Language Model API (`vscode.lm.selectChatModels`, `model.sendRequest` with tools) is an *official* extension API for using the models from the user's Copilot plan, behind a VS Code consent prompt. That avoids the headless-runtime question entirely.
- **Adapter:** `packages/providers/src/subscriptions/vscode-lm.ts` implements `ChatProvider` on top of `vscode.lm`. Tools are passed in the request options; tool results go back as tool-result parts (*verify* the current API shape and quotas).
- **Limits:** no prompt caching control and no mid-conversation system role (use stage 3's Gemini-style context wrapper). The model choice is whatever the user's plan allows.
- **Scope:** works in the VS Code extension only, not the desktop app (stage 7).
- **Order:** do this adapter **first** in this stage. It has the clearest terms story (*verify* in the terms gate anyway) and the widest student reach.

### 4.7 UX
- **Setup:** the setup panel gets a "Use my subscription" section. It lists only the adapters whose flags are on, with plain-language notes on age limits, account sharing and data use, *before* sign-in.
- **Usage meter:** shows "subscription" instead of dollars, plus any rate-limit messages the runtime reports.
- **Missing runtime:** a clear install step, with no silent installs.

## 5. Task breakdown
**PR 0: terms gate**
- [ ] M: `docs/policy/subscriptions.md` research + vendor emails where unclear (blocks everything else per vendor)

**PR 1: MCP server**
- [ ] M: `packages/mcp-server` over the stage 1 registry, level-aware, with an MCP conformance test

**PR 2: runtime supervisor**
- [ ] M: `runtime.ts` (spawn, health check, restart, version detection, clean shutdown)

**PR 2b: Copilot via `vscode.lm`** (first, if the gate passes)
- [ ] M: `vscode-lm.ts` + consent flow + tool mapping + eval run

**PR 3: Codex adapter** (if the gate passes)
- [ ] L: `codex.ts` + config + canary check + approval auto-deny + event mapping

**PR 4: Gemini adapter** (if the gate passes)
- [ ] L: `gemini-acp.ts` + settings + canary + event mapping

**PR 5: Claude adapter** (only with Anthropic approval)
- [ ] M: `claude-agent.ts`

**PR 6: UX and evals**
- [ ] M: setup section, meter, banners
- [ ] M: eval runs per adapter → `docs/measurements/evals-v6.md`

## 6. Testing and verification
- The MCP server passes conformance tests, and L0 never lists `propose_diff`.
- Per adapter, with a recorded or mocked runtime:
  - built-in write/shell tools are unavailable, and a forced approval request is auto-denied;
  - the canary confirms the pedagogy prompt is active;
  - a blocked turn is replaced by the rephrase turn.
- **Live, manual:** sign in with a test account and run 3 scenarios end to end in the extension.
- The eval bar is met through the adapter, and the rate of rephrase turns is reported.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| The terms forbid this, or change later | Terms gate per vendor, re-checked each release; the flag can be switched off remotely by shipping an update |
| Runtimes change their protocols often | Version pinning per adapter; detect and refuse unsupported versions with a clear message |
| A runtime's built-in tools bypass the guardrails | Disable them by configuration, auto-deny approvals, test it; refuse to run if this can't be confirmed |
| Age limits make the path unusable for students | Say so up front; position it as a mentor or 18+ option; the API-key path stays the main one |
| The runtime's own system prompt fights the pedagogy prompt | Canary check, evals, per-adapter prompt deltas |

## 8. Open questions
- Is the Copilot path (§4.6) good enough on the eval bar with the models students' plans include? If it is, it could become the default recommendation for teams with no budget.
- Should the adapters run the runtime per session, or keep one per VS Code window? Start with one per window.

## 9. Out of scope
- Extracting or reusing subscription OAuth tokens directly. CodeCoach never does this.
- Shared team logins.
