# CodeCoach stage plans

`../PLAN.md` is the master plan. These docs expand each milestone into something you can implement directly. If a stage doc and `PLAN.md` disagree, update both rather than letting them drift.

Every stage doc has the same nine sections: Goal, Depends on / unblocks, Deliverables, Design detail, Task breakdown, Testing and verification, Risks and mitigations, Open questions, Out of scope.

Task sizes: **S** ≈ under half a day, **M** ≈ 1–3 days, **L** ≈ a week or more (estimates for one person working part-time on the project).

## Stages

| # | Stage | Doc | Status |
|---|---|---|---|
| 0a | Dev environment | [00a-dev-environment.md](00a-dev-environment.md) | Done |
| 0b | Scaffolding and CI | [00b-scaffolding-ci.md](00b-scaffolding-ci.md) | Done |
| 1 | Core agent, pedagogy v1, CLI, evals v1 | [01-core-and-pedagogy.md](01-core-and-pedagogy.md) | Built and tested offline; live criteria move to 1b |
| 1b | Subscription transport (Claude Code, development-only) and spending gate | [01b-subscription-transport.md](01b-subscription-transport.md) | Built and verified live; waiting on the eval baseline and judge calibration |
| 2 | VS Code extension MVP | [02-vscode-extension.md](02-vscode-extension.md) | Not started |
| 3 | OpenAI and Google API-key providers | [03-multi-provider.md](03-multi-provider.md) | Deferred (only if the spending gate is lifted) |
| 4 | Logs, simulation and NetworkTables | [04-logs-sim-nt.md](04-logs-sim-nt.md) | Not started |
| 5 | Docs index, FRC lints, C++/RobotPy depth | [05-docs-index-and-lints.md](05-docs-index-and-lints.md) | Not started |
| 6 | Student-facing subscription adapters (comes right after 2) | [06-subscription-adapters.md](06-subscription-adapters.md) | Not started |
| 7 | Desktop app | [07-desktop-app.md](07-desktop-app.md) | Not started |
| 8 | Pilot, i18n and onboarding | [08-pilot-and-i18n.md](08-pilot-and-i18n.md) | Not started |
| 9 | Sponsor token pool | [09-sponsor-pool.md](09-sponsor-pool.md) | Not started (only if a sponsor materializes and the spending gate is lifted) |

## Spending policy
No API-key spending for the rest of the project unless the owner lifts the gate after the feasibility checkpoint (stages 1–2 exit criteria met). See PLAN.md, Decisions → Spending. Development and evals run on the owner's Claude Pro/Max subscription through Claude Code (1b); students use subscription runtimes (6).

## Dependency graph

```
0a ──► 0b ──► 1 ──► 1b ──► 2 ──► 6 ──► 8 (pilot needs 2, 4, 5, 6)
              │            │
              │            ├──► 4 ──┘
              │            │
              │            └──► 5 ──┘
              │
              └──► 7 (after 2 proves the UI; needs packages/ui)

Feasibility checkpoint after 2: the owner decides whether the spending gate ever lifts.
Only if it lifts:
  3  OpenAI and Google API-key adapters (after 1b's gate exists).
  9  Sponsor pool: after everything else, and only if a sponsor commits.
     Depends only on the ChatProvider interface (stage 1); nothing depends on it.
```

**Parallel tracks:**
- **Coach quality:** 1 → 1b → 6. Every prompt change goes through the eval suite, run on the subscription transport.
- **FRC depth:** 4 and 5 can run in parallel once 2 lands.
- **Reach:** 7, then 8.
- **Behind the spending gate:** 3 and 9. 9 is a separate track that a separate contributor could own, and it is the last thing built.

## Conventions used across stages
- **Packages:** npm scope `@codecoach/*`. Each workspace package has `src/`, `test/`, and its own `tsconfig.json` referenced from the root `tsconfig.json`.
- **Tool names:** the model-facing tools are `snake_case` (`read_file`, `run_build`, `query_log`). Their JSON schemas are generated from Zod schemas in `packages/frc/src/tools/` or `packages/core/src/tools/`.
- **Team config:** `.codecoach/config.json` in the *robot* repo, validated by `packages/core/schema/config.schema.json` (generated from Zod).
- **Fixtures:** `fixtures/<lang>-<controller>-<bug>/`, e.g. `fixtures/java-roborio-default-command-bug/`. Every fixture has `scenario.yaml` (simulated student + expected diagnosis).
- **Pinned versions:** the root `package.json` (`packageManager`, `engines`) and `.node-version` are the only places tool versions are pinned. The NixHub flake follows them.
- **JDKs:** code never reads `JAVA_HOME` directly. It always goes through `packages/frc/src/jdk.ts`.
- **Branches:** one branch and one PR per task group in each doc's task breakdown.
- **verify:** text marked *verify* is a fact to confirm against the vendor docs (WPILib, CTRE, REV, the LLM providers) during that stage.
