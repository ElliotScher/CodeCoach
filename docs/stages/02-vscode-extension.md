# Stage 2: VS Code extension MVP

> **Spending amendment (2026-10-17).** No API-key spending for the rest of the project unless the owner lifts the gate after the feasibility checkpoint (PLAN.md, Decisions → Spending). Development and evals run on the owner's Claude Pro/Max subscription through Claude Code ([stage 1b](01b-subscription-transport.md)). During development the extension's provider is the Claude Code transport from 1b (the owner plays the student). Student-facing providers come from stage 6, which now follows this stage directly; API-key setup stays hidden behind an experimental setting.

## 1. Goal
Put the coach where students already are: inside WPILib VS Code. A student opens their robot project, picks a provider (a subscription they already have, signed in through the vendor's own runtime), and gets a chat panel that knows their project. The panel can explain build errors from the Problems panel and coaches at the level their mentor or team lead set.

**Exit criteria (from PLAN.md):**
- A student in WPILib VS Code fixes a planted build error and a planted logic bug with the coach.
- The L0 violation rate is 0 on the eval suite. The checker runs on the same path inside the extension, so the evals cover it.

## 2. Depends on / unblocks
- **Depends on:** 1 (core, Anthropic provider, tools, pedagogy, checker).
- **Unblocks:** 3 (provider picker UI), 4 (log viewer entry points), 5 (cited docs rendering), 7 (`packages/ui` proven), 8 (pilot).

## 3. Deliverables
```
apps/vscode/src/
  extension.ts              # activate: register views, commands, code actions
  chat-view.ts              # WebviewViewProvider, owns one AgentSession per chat
  protocol.ts               # typed (Zod) host⇄webview messages
  secrets.ts                # SecretStorage wrapper per provider (API keys; hidden while the spending gate is closed)
  team-config.ts            # load/validate/watch .codecoach/config.json; mentor lock
  diagnostics.ts            # DiagnosticCollection for run_build results
  code-actions.ts           # "Explain this error with CodeCoach"
  diff-review.ts            # L3 propose_diff → diff editor + accept/reject
  secret-scan.ts            # pre-send scanner
  storage.ts                # sessions in workspaceStorage
packages/ui/src/
  Chat.tsx  Message.tsx  Composer.tsx  PhaseBadge.tsx  Meter.tsx
  Setup.tsx  PrivacyBanner.tsx  markdown.ts (sanitized)
apps/vscode/test/suite/*.test.ts
docs/user/getting-started.md   docs/user/for-mentors.md
```

## 4. Design detail

### 4.1 Architecture inside VS Code
- **Extension host (Node).** The core `Agent` runs here, together with the tools (with workspace access), the provider SDKs and secrets.
- **Webview.** The webview is rendering only. It has **no** network access or secrets (CSP `default-src 'none'`; scripts by nonce; `connect-src` none).
- **Protocol.** All traffic between the two goes through `postMessage` with Zod-validated messages:
  - `send`, `abort`, `escapeHatch`, `acceptDiff`;
  - `streamDelta`, `toolActivity`, `turnCommitted`, `stateChanged`, `meter`, `error`.
- **Styling.** The webview uses VS Code theme CSS variables, so light, dark and high-contrast all work without extra work.

### 4.2 First-run setup
1. On activation in a folder that looks like a robot project (`build.gradle` with GradleRIO, or `pyproject.toml` with robotpy), offer: "Want a coding mentor? Set up CodeCoach."
2. **Setup panel:**
   - pick a provider;
   - paste a key, stored with `context.secrets.store("codecoach.key.<provider>")`;
   - a test call with a tiny prompt that shows success.
3. **Choose your experience level** ("new to programming / some Java / comfortable"). This is stored per user in `globalState`, not in the repo.
4. If `.codecoach/config.json` is missing, offer *Set up CodeCoach for this team* (§4.4).

### 4.3 Commands and entry points
| Command / entry | Behavior |
|---|---|
| `codecoach.openChat` | Focus the chat view |
| `codecoach.askAboutSelection` (editor context menu) | Pre-fills the composer with the file, line range and selected code, then asks "What would you like to understand about this?" The student still writes the question |
| `codecoach.explainDiagnostic` (code action on any diagnostic) | Starts a turn with the diagnostic (message, file, line, source). The coach starts in `describe`/`hypothesize`: "What do you think this error means?" |
| `codecoach.startDebugging` | Opens a guided session that enters `describe` |
| `codecoach.runBuild` | Runs `run_build` with the resolved JDK; results go to the Problems panel under the source "CodeCoach" |
| `codecoach.setupTeam` | Team config wizard (§4.4) |
| `codecoach.changeLevel` | Change the guardrail level (needs the lock's passphrase, if one is set) |

### 4.4 Team config and the mentor lock
`.codecoach/config.json` is committed with the robot code:
```jsonc
{
  "$schema": "https://…/config.schema.json",   // bundled with the extension too
  "version": 1,
  "team": 9999,
  "guardrails": {
    "level": "L0",
    "lock": { "kdf": "scrypt", "salt": "…", "params": {"N":32768,"r":8,"p":1},
              "signature": "…" }                // HMAC(key=scrypt(passphrase), "codecoach:L0:9999")
  },
  "providers": { "allowed": ["anthropic", "openai", "google"], "models": {} },
  "budget": { "monthlyUsd": 20 },
  "language": "en",
  "readingLevel": "standard"
}
```
**Mentor lock:**
- **Setting and checking.** Setting a lock asks for a passphrase. The guardrail level is signed with a key derived from it. On load, the extension checks the signature. If the level was edited by hand, or the signature doesn't match, the extension **falls back to L0** and shows a notice: "guardrail level couldn't be verified".
- **Changing the level** in the UI needs the passphrase.
- **Teams without a mentor** (CodeCoach's main audience) can let a student lead hold the passphrase, or leave the lock off.
- **Threat model.** This is honestly a deterrent, not security. The salt and signature are in the repo, so a determined student could brute-force a weak passphrase offline or delete the lock (which then shows up in git history). The docs say exactly this. Real enforcement exists only with the server-side pool (stage 9).
- **Budget.** Applies only to API-key providers, which are off while the spending gate is closed. If they're ever enabled, the monthly budget is tracked per machine (in `globalState`), not across the whole team, and the docs explain that a provider-side spend limit (set in the provider console) is the real cap.

### 4.5 Chat panel UX
- **Streaming.** Text streams in; tool activity shows as quiet one-line chips ("Reading RobotContainer.java", "Building with JDK 17…"). These can be expanded to show what the coach looked at, which teaches students where to look themselves.
- **Phase badge** (Describe → Hypothesize → …). The student can click it to see "where we are in debugging". This makes the process visible and teachable.
- **Quick replies:** "I tried it", "I'm stuck, give me a hint", "Just tell me" (escape hatch, after confirmation), and "I don't understand that word" (asks for a simpler explanation).
- **Meter:** tokens and turns this session, plus any usage-limit messages from the subscription runtime. Dollars and the monthly budget appear only for API-key providers.
- **Privacy banner** (always visible, collapsible): "Your messages and the files CodeCoach reads are sent to *Anthropic*. Nothing else leaves your computer."
- **Markdown:** rendered with `markdown-it` with HTML disabled and a link allowlist (`https:` only; links open via `vscode.env.openExternal` after confirmation). Code is highlighted with `highlight.js` (Java, C++, Python, Gradle, JSON).
- **Accessibility:**
  - an ARIA live region for streamed text;
  - every action keyboard reachable;
  - font size follows `editor.fontSize`;
  - no color-only signals.

### 4.6 Problems panel and diagnostics
- `run_build` results are published to a `DiagnosticCollection("codecoach")`.
- The code action provider attaches *Explain with CodeCoach* to **any** diagnostic: our own, Java (redhat.java), C++ (cpptools/clangd) and Python (Pylance).
- The diagnostic's text goes to the coach. The full file is read only if the coach calls `read_file`, so the student can see it in the activity chips.

### 4.7 L3 diff review
- `propose_diff` produces a unified diff.
- `diff-review.ts` opens `vscode.diff(original, proposed)` with a virtual `codecoach-proposal:` document, plus **Accept** and **Reject** buttons.
- Accept applies a `WorkspaceEdit` and records it in the session. The coach then asks the student to explain what the change does: reflection is the point.

### 4.8 Secret scan before sending
- **What's scanned:** before anything leaves the machine — the student's message, selection pre-fills and tool results headed to the provider.
- **Patterns:** `sk-ant-…`, `sk-…`, `AIza…`, `ghp_…`/`github_pat_…`, `-----BEGIN … PRIVATE KEY-----`, and `KEY=`/`TOKEN=`/`SECRET=` lines.
- **On a hit:** the content is redacted, with a notice showing what was removed. Tool results from `read_file` on matching lines are redacted the same way.

### 4.9 Compatibility and packaging
- **Target:** test against the VS Code version bundled by the current WPILib installer (*verify* the version and set `engines.vscode` at or below it). No proposed APIs.
- **Distribution:**
  - publish to the VS Code Marketplace and Open VSX;
  - also attach the `.vsix` to GitHub Releases, because some school networks block marketplaces and teams install offline from a USB stick;
  - *verify* how WPILib VS Code handles third-party extensions from the marketplace.
- **Size budget:** under 10 MB `.vsix`, including the tree-sitter WASM grammars.

## 5. Task breakdown
**PR 1: view and protocol**
- [ ] M: `chat-view.ts`, `protocol.ts`, `packages/ui` Chat/Message/Composer with streaming
- [ ] S: CSP, nonce, theme variables

**PR 2: setup and secrets**
- [ ] M: setup flow, `secrets.ts`, test call, experience level
- [ ] S: privacy banner

**PR 3: team config and lock**
- [ ] M: `team-config.ts` (schema validation, file watcher, signature check, L0 fallback)
- [ ] M: setup-team wizard, change-level flow
- [ ] S: `docs/user/for-mentors.md` (including the honest threat model)

**PR 4: diagnostics and code actions**
- [ ] M: `diagnostics.ts`, `codecoach.runBuild`, code action provider
- [ ] S: ask-about-selection

**PR 5: L3 diff review**
- [ ] M: `diff-review.ts`

**PR 6: safety and polish**
- [ ] M: `secret-scan.ts` + tests
- [ ] M: phase badge, quick replies, meter, accessibility pass
- [ ] S: `docs/user/getting-started.md` (with screenshots)

**PR 7: release**
- [ ] M: Marketplace + Open VSX publishing in a `release.yml` on tags; `.vsix` on GitHub Releases

## 6. Testing and verification
- **`@vscode/test-electron` suite** against fixture workspaces, with a mock provider enabled by `codecoach.dev.mockProvider` (hidden setting):
  - activation;
  - the setup flow stores the secret;
  - a code action appears on a diagnostic;
  - `runBuild` publishes diagnostics;
  - a tampered `config.json` falls back to L0;
  - an L3 accept applies the edit;
  - the secret scanner redacts.
- **Webview component tests** for `packages/ui` (vitest + happy-dom).
- **Manual, in WPILib VS Code:** a student-tester pass on `java-roborio-build-error` (a planted missing import or type mismatch) and `java-roborio-default-command-bug`, timed and observed. Note every confusing moment.
- **Evals:** run unchanged (the core path is shared). L0 violations shown: 0.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Students paste keys into chat or commit them | Setup flow is the only key entry; the secret scanner catches pasted keys; `.env*` stays in the gitignore template recommended in the docs |
| The mentor lock gives a false sense of security | Honest threat-model docs; server-side enforcement only in stage 9 |
| WPILib VS Code's version is older than our `engines` | Keep `engines` low; CI matrix includes WPILib's version |
| Webview performance with long sessions | Virtualized message list; collapse old tool chips |
| School networks block provider APIs | Clear error with the endpoint names to ask IT to allow |

## 8. Open questions
- One chat per workspace, or multiple named sessions? Start with one active session plus a history list.
- Should "Explain this error" also be offered as a hover? Possibly; check in the pilot whether it's noisy.
- Should per-machine budget tracking sync via the repo (e.g. a usage file)? Probably not, because it creates merge conflicts. Rely on provider-side limits.

## 9. Out of scope
- Other providers' setup (stage 3), and the log, sim and NT entry points (stage 4).
- Telemetry of any kind.
