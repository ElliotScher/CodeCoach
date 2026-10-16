# Stage 5: docs index, FRC lints, C++ and RobotPy depth

## 1. Goal
Three things that make the coach feel like an FRC mentor rather than a general-purpose chatbot:
1. **It points students to the real docs** for *their* season, with citations, so they learn where answers live and the coach's links are never made up.
2. **It notices common FRC mistakes** through deterministic lint checks. It raises them as things to discuss ("I see two motors using CAN ID 5. What do you think happens then?"), not as automatic fixes.
3. **C++ and RobotPy support as good as Java.** These students are often the most stranded, because fewer mentors know those stacks.

**Exit criteria (from PLAN.md):**
- Answers cite season-correct docs.
- Every lint fires on its positive fixture and stays silent on all clean projects.

## 2. Depends on / unblocks
- **Depends on:** 1 (tools, analyzer, tree-sitter outlines), 2 (citation and diagnostic UI).
- **Unblocks:** 8 (the pilot needs C++ and RobotPy teams supported).

## 3. Deliverables
```
packages/frc/src/docs/
  build-index.mjs        # offline index builder (run in CI per season)
  index.ts               # MiniSearch BM25 loader + search
  sources.json           # each source: URL, license, season branches, mode (full-text | link-only)
packages/frc/src/lint/
  engine.ts              # runs rules over tree-sitter trees + analyzer summary
  rules/FRC0xx-*.ts      # one file per rule
  constants.ts           # resolves simple `static final int` / constexpr / module-level constants
packages/frc/src/cpp/    # C++ error summarizer, units-library explainer helpers
packages/frc/src/python/ # RobotPy project helpers (sync, components)
packages/pedagogy/src/links.ts   # URL allowlist + link verification in the checker
fixtures/lint/<rule-id>/{positive,negative}/
fixtures/cpp-roborio-*, fixtures/python-roborio-*   # new eval scenarios
```

## 4. Design detail

### 4.1 Docs sources and licensing
| Source | Mode | Notes |
|---|---|---|
| WPILib frc-docs (`wpilibsuite/frc-docs`) | full text | CC BY 4.0 (*verify*): attribute in the UI and in `NOTICE` |
| WPILib API reference (Javadoc, C++ Doxygen) | symbol index: names, signatures, one-line summaries, URLs | *verify* the license of the generated docs (allwpilib is BSD) |
| RobotPy docs | full text or symbol index | *verify* the license |
| CTRE Phoenix 6, REV, PathPlanner, PhotonVision, AdvantageKit docs | **link-only** unless the license allows more: titles, headings and URLs from sitemaps | Ask the vendors; many may happily allow full-text indexing for an educational tool |

- **Season versioning.** The index is built per season, following frc-docs' versioned branches and the API docs for each release. The project's `projectYear` selects the index; if that year's index is missing, the nearest year is used, with a notice.
- **Search.** MiniSearch (pure-JS BM25) over chunks split at headings of about 300–600 words. No embeddings and no network calls: it works offline and costs nothing per query.
- **Distribution.** Indexes are built in CI and published as GitHub Release assets with SHA-256 sums. The extension downloads the current season's index on first use and verifies the hash, so the `.vsix` stays small. An offline-install bundle includes it.

### 4.2 `search_docs` and citations
- **Tool:** `search_docs(query, kind?: "guide" | "api", k=5)` → `[{title, url, season, excerpt, source}]`.
- **UI:** cited results show as citation chips. The coach is told to quote briefly and send the student to read the page ("Section *Default Commands* explains this, so have a look and tell me what you think `setDefaultCommand` does").
- **Link verification** (`links.ts`, part of the response checker). Every URL in a coach response must either:
  - have come from a `search_docs` result this session, or
  - be on a small allowlist of root domains (docs.wpilib.org, github.com/wpilibsuite, the vendor docs roots).

  Anything else is removed before display and logged. This stops made-up links from reaching the student.

### 4.3 Lint engine
- **Rule shape:** each rule has an `id`, `languages`, `appliesTo` (controller and pattern), a tree-sitter query or a visitor, and a `coachNote`. The coachNote is a hint *for the coach*, not the student, and includes the docs link.
- **Output:** `Finding { id, file, range, confidence, coachNote }`.
- **Where findings appear:**
  1. In `analyze_project` output, so the coach can bring them up when relevant to what the student is working on.
  2. Optionally as VS Code diagnostics with the source "CodeCoach (possible issue)". This is **off by default**, so the extension doesn't feel like a linter that hands out answers. A diagnostic's text names the *concern*, never the fix.
- **Constants:** `constants.ts` resolves simple constant references (`Constants.DriveConstants.kLeftMotorId`), so CAN-ID checks work in real code.

**v1 rules:**
| ID | Check | Langs |
|---|---|---|
| FRC001 | Duplicate CAN ID on the same bus (motor controllers, encoders, Pigeon, CANdle), across constructors and constants | J, C++, Py |
| FRC002 | A command uses a subsystem but doesn't declare it as a requirement (subclass without `addRequirements`; factory without the requirements argument) | J, C++, Py |
| FRC003 | A blocking call in `periodic`/`execute` (`Thread.sleep`, `Timer.delay`, `time.sleep`, a busy-wait loop on a sensor) | J, C++, Py |
| FRC004 | Command-based project whose `robotPeriodic` doesn't run the `CommandScheduler` | J, C++, Py |
| FRC005 | Vendordep `frcYear` ≠ project year | all |
| FRC006 | JDK mismatch (from the resolver) | J, C++ |
| FRC007 | Hardware objects constructed inside periodic or loop code | J, C++, Py |
| FRC008 | Units smell: trig on a value named `*deg*`; `fromDegrees` given a value named `*rad*`; mixing units-library types via `.value()` | J, C++, Py |
| FRC009 | A subsystem used by teleop bindings with no default command and no binding that drives it (low confidence) | J, C++, Py |
| FRC010 | C++: a lambda capturing `[&]` stored in a command that outlives its scope (dangling reference) | C++ |
| FRC011 | C++: an override without `override`, or a `Command*` returned from a temporary (lifetime) | C++ |
| FRC012 | Python: a `Subsystem`/`Command` subclass `__init__` missing `super().__init__()` | Py |

- **Exact query syntax:** settled per rule with its fixtures.
- **False positives** are worse than misses, because a wrong concern teaches the wrong thing. Ship a rule only if it is silent on every clean fixture *and* on 3 or more real open-source team repos (with permission or public licenses).

### 4.4 C++ depth
- **Error summarizer:** collapses template instantiation backtraces to the first user-code frame plus the core message. It also recognizes the common WPILib C++ traps:
  - units-library type mismatches ("you passed `units::meter_t` where `units::second_t` is expected");
  - `CommandPtr` vs. raw `Command*` ownership;
  - header/source signature mismatches;
  - a missing `#include`.
- **Prompt delta:** C++-specific mentoring notes: lifetimes, ownership, and reading compiler errors from the first error, not the last.
- **New scenarios:**
  - `cpp-roborio-units-mismatch`;
  - `cpp-roborio-dangling-lambda`;
  - `cpp-roborio-missing-override`.

### 4.5 RobotPy depth
- **Analyzer additions:** `pyproject.toml` `[tool.robotpy]` components vs. imports (e.g. `commands2` used but not listed → "run `robotpy sync`"), plus the Python version check.
- **Running:** `python -m robotpy test` and `python -m robotpy sim` through the venv the project uses (*verify* how RobotPy recommends managing environments for the current season).
- **Python errors:** indentation, `self` mistakes, mutable default arguments, and mixing `wpilib` and `commands2` APIs.
- **New scenarios:**
  - `python-roborio-indentation`;
  - `python-roborio-missing-sync`;
  - `python-roborio-default-command-bug`.

## 5. Task breakdown
**PR 1: docs index**
- [ ] M: `sources.json` + license review (ask vendors where needed)
- [ ] L: `build-index.mjs` (frc-docs RST/Markdown → chunks; Javadoc/Doxygen → symbol index), CI job per season, release assets
- [ ] M: `index.ts`, download + hash verification, `search_docs` tool, citation chips

**PR 2: link verification**
- [ ] M: `links.ts` in the checker + tests (made-up URL removed, cited URL kept)

**PR 3: lint engine**
- [ ] M: `engine.ts`, `constants.ts`, finding plumbing into analyzer + optional diagnostics
- [ ] L: rules FRC001–FRC009 with positive and negative fixtures
- [ ] M: rules FRC010–FRC012
- [ ] M: real-repo false-positive sweep

**PR 4: C++ and RobotPy**
- [ ] M: C++ error summarizer + units explainer
- [ ] M: RobotPy analyzer additions + runner
- [ ] L: 6 new eval scenarios + run → `docs/measurements/evals-v5.md`

## 6. Testing and verification
- Index build is reproducible: the same commit produces the same index hash. A search for "default command" on the current season returns the frc-docs page.
- Each season's index resolves for fixtures of that year.
- Lint: every rule fires on its positive fixtures, and there are 0 findings across all clean fixtures and the real-repo sweep.
- Link verification: an eval-wide count of removed links is reported. The target is at most 1 per 100 turns, with the trend going down.
- C++ and RobotPy scenarios meet the stage 3 bar on at least one provider.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Vendor licenses forbid full-text indexing | Link-only mode; ask the vendors; the coach still points to the right page |
| Lints teach wrong lessons through false positives | Conservative rules; confidence field; real-repo sweep; findings framed as questions |
| Index size and download in restricted school networks | Offline bundle; small per-season assets |
| Docs restructure between seasons breaks links | Index rebuilt per season; link verification against the index |

## 8. Open questions
- Should students be able to search docs directly from the panel, without the coach? Probably yes: it's cheap and builds independence.
- Should the coach see findings that aren't related to the current question? Only as background. The prompt tells it not to dump findings on students; it can bring one up when the moment is right.

## 9. Out of scope
- Embedding-based or semantic search (revisit only if BM25 measurably fails in the evals).
- Auto-fixes for lint findings.
