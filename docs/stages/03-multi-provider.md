# Stage 3: OpenAI and Google providers

## 1. Goal
Teams can coach with whichever provider they already have access to (through school, sponsor credits or a personal account) and get the **same coaching behavior** from all of them. The eval suite, not intuition, decides whether a provider and model is good enough to offer, and which small prompt adjustments it needs.

**Exit criteria (from PLAN.md):**
- All three providers pass the eval bar (§4.5).
- Switching providers mid-session works and keeps the conversation and coaching state.

## 2. Depends on / unblocks
- **Depends on:** 1 (`ChatProvider`, evals), 2 (provider picker in the UI).
- **Unblocks:** 6 (subscription adapters reuse the per-provider translation layers), 8 (the pilot can include teams on any provider).

## 3. Deliverables
```
packages/providers/src/
  openai.ts             # Responses API adapter
  google.ts             # @google/genai adapter
  translate/            # neutral ⇄ provider message/tool translation, one file per provider
  prices.json           # per-model $/MTok (input, cached input, output); dated, manually updated
  data-policies.ts      # per-provider privacy notes shown in the UI (§4.4)
packages/pedagogy/src/providers/{anthropic,openai,google}.ts   # small prompt deltas
packages/evals/src/matrix.ts   # cross-provider score matrix + bar check
docs/measurements/evals-v3.md
```

## 4. Design detail

### 4.1 OpenAI adapter (Responses API)
- **SDK:** `openai`, `client.responses.stream(...)` (*verify* the current method and event names).
- **Mapping:**
  - top-level instructions + developer-role messages ↔ CodeCoach's system layers, with the per-turn coaching context as a developer message after the user turn;
  - tools ↔ `type: "function"` tools with `strict: true` (schemas from the same Zod definitions; strict mode needs `additionalProperties: false` and every field required, so optional fields become nullable);
  - streamed text deltas and function-call argument deltas → `text_delta` / `tool_call`;
  - the completed event → `turn_end` with usage.
- **Privacy:** send `store: false` so OpenAI doesn't keep the conversation state server-side. Replay the full history every turn. Where reasoning models need their reasoning carried across turns, request the encrypted reasoning items and pass them back unchanged (*verify* the include flag).
- **Caching:** automatic prefix caching. Keep the same byte-stable prefix order as Anthropic, and set a stable `prompt_cache_key` per session (*verify*).
- **Models:** the default and the cheap model are chosen at the start of the stage from `models.list()` plus eval results. Nothing is hard-coded beyond `prices.json`.

### 4.2 Google adapter (`@google/genai`)
- **SDK:** `ai.models.generateContentStream(...)` with `systemInstruction`, `tools: [{ functionDeclarations }]` and `contents` (*verify*).
- **Mapping:**
  - per-turn coaching context: Gemini has no mid-conversation system role, so it goes in as a clearly delimited `user`-role part (`<coaching_context>…</coaching_context>`) prepended to the student's message. The prompt delta tells the model this block comes from the app, not the student;
  - `functionCall` parts → `tool_call`; results go back as `functionResponse` parts in a single turn.
- **Thought signatures:** newer Gemini models return signatures on function-call parts that must be sent back unchanged, so raw parts are stored per turn, as with Anthropic (*verify* for the chosen model).
- **Caching:** rely on implicit caching for the stable prefix first. Consider explicit context caching (`caches.create`) only if the evals show long sessions are expensive.
- **Models:** chosen from `models.list()` plus evals, as for OpenAI.

### 4.3 Switching providers mid-session
- **Neutral history is canonical** (stage 1 §4.1). On a switch, the new provider receives the translated neutral history; the old provider's raw blocks (thinking, signatures, encrypted reasoning) are dropped.
- **Coaching state** (phase, hypothesis, attempts) is app-side, so it carries over untouched.
- **Tool calls** are translated into the new provider's shape, with IDs preserved where possible and remapped otherwise.
- **UI:** a separator in the chat ("Switched to Google Gemini") and an updated privacy banner.

### 4.4 Data policies in the UI (minors)
Each provider's banner states, in plain words, whether API data may be used for training and how long it is retained. These facts change, so they live in `data-policies.ts` with a source URL and "checked on" date, and are re-checked each release.
- **Anthropic and OpenAI APIs:** not used for training by default; retained for a limited time for abuse monitoring (*verify* the current terms).
- **Google Gemini API:** **free-tier** usage may be used to improve Google's products, while paid tiers are not (*verify*). CodeCoach must warn clearly when a key looks like a free-tier key, or when the user says it is, and suggest a paid or education-credit key. This matters a lot for minors' code and messages.

### 4.5 The eval bar
A provider and model is offered in the UI as "Recommended" only if the full suite meets these thresholds:
| Rubric item | Bar |
|---|---|
| (a) no solution beyond the level, checker-verified, as shown to the student | 0 violations shown; rewrite rate ≤ 10% |
| (b) asked for a hypothesis before explaining | ≥ 90% of bug scenarios |
| (c) correct diagnosis | ≥ 85% |
| (d) encouraging tone, no banned phrases in what is shown | ≥ 95% |
| (e) pointed to docs or tools | ≥ 75% |
| (f) simulated student reached the fix | ≥ 70% |

- **Below the bar:** a model can still be chosen under "Other models (not tuned)", with a notice.
- **Runs:** the simulated student and the judge stay fixed (Anthropic models) across all providers, so only the coach changes.
- **Report:** `matrix.ts` emits a table per scenario × provider/model, plus cost per completed scenario.

### 4.6 Per-provider prompt deltas
- **Scope:** small, documented adjustments only. Examples: Gemini's coaching-context wrapper; reminders about tool-result formats; tuning how verbose a provider tends to be.
- **Rule:** every delta needs an eval result that justifies it, noted in a comment next to it with the run ID. A delta that doesn't move a score gets deleted.

## 5. Task breakdown
**PR 1: translation layer**
- [ ] M: `translate/` with round-trip tests (neutral → provider → neutral) for text, tool calls, tool errors and parallel results

**PR 2: OpenAI**
- [ ] L: `openai.ts` streaming, strict tools, `store: false` replay, reasoning-item passthrough, error mapping
- [ ] S: recorded HTTP fixtures

**PR 3: Google**
- [ ] L: `google.ts` streaming, function calling, thought-signature passthrough, coaching-context wrapper
- [ ] S: recorded HTTP fixtures

**PR 4: switching and UI**
- [ ] M: mid-session switch in core + UI separator + banner update
- [ ] M: `data-policies.ts` + free-tier warning
- [ ] S: `prices.json` + meter uses it

**PR 5: evals**
- [ ] M: `matrix.ts`, bar check, "Recommended" flag generation
- [ ] L: tuning passes + `docs/measurements/evals-v3.md`

## 6. Testing and verification
- Translation round-trip unit tests, plus recorded-fixture tests per adapter (streaming events → `ChatEvent` sequence).
- The switch test: start on Anthropic with two tool rounds, switch to OpenAI, then to Google. Coaching state is kept and no provider rejects the translated history.
- Live smoke test per provider (behind keys): one tool round, with usage and cost shown.
- The full eval matrix meets the bar for at least one model per provider. Results go into `evals-v3.md`.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Provider APIs change shape (fast-moving) | Thin adapters, recorded fixtures, a smoke job weekly against live APIs |
| Weaker models give away answers more often | The checker catches it in code; the bar keeps those models out of "Recommended" |
| Free-tier data use exposes minors' content | Prominent warning; docs recommend paid or education credits; no free-tier default |
| Translated history loses information when switching | Neutral form keeps all text and tool I/O; only provider-private reasoning is dropped, which is fine |

## 8. Open questions
- Should Ollama or local models be added as a fourth, experimental provider for teams with zero budget? It's useful for equity, but the coaching quality is likely below the bar. Revisit after the pilot, and label it clearly if added.
- Azure OpenAI, Vertex and Bedrock endpoints for schools with enterprise agreements? Add them on request; the adapters mostly need different client construction.

## 9. Out of scope
- Consumer subscription logins (stage 6).
- Sponsor-pool routing (stage 9).
