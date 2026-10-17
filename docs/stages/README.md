# CodeCoach stage plans

`../PLAN.md` is the master plan. These docs expand each milestone into something you can implement directly. If a stage doc and `PLAN.md` disagree, update both rather than letting them drift.

Every stage doc has the same nine sections: Goal, Depends on / unblocks, Deliverables, Design detail, Task breakdown, Testing and verification, Risks and mitigations, Open questions, Out of scope.

Task sizes: **S** ≈ under half a day, **M** ≈ 1–3 days, **L** ≈ a week or more (estimates for one person working part-time on the project).

## Stages

| # | Stage | Doc | Status |
|---|---|---|---|
| 0a | Dev environment | [00a-dev-environment.md](00a-dev-environment.md) | Done |
| 0b | Scaffolding and CI | [00b-scaffolding-ci.md](00b-scaffolding-ci.md) | Done locally; waiting on the first green CI run and branch protection |
| 1 | Core agent, pedagogy v1, CLI, evals v1 | [01-core-and-pedagogy.md](01-core-and-pedagogy.md) | Not started |
| 2 | VS Code extension MVP | [02-vscode-extension.md](02-vscode-extension.md) | Not started |
| 3 | OpenAI and Google providers | [03-multi-provider.md](03-multi-provider.md) | Not started |
| 4 | Logs, simulation and NetworkTables | [04-logs-sim-nt.md](04-logs-sim-nt.md) | Not started |
| 5 | Docs index, FRC lints, C++/RobotPy depth | [05-docs-index-and-lints.md](05-docs-index-and-lints.md) | Not started |
| 6 | Subscription adapters | [06-subscription-adapters.md](06-subscription-adapters.md) | Not started |
| 7 | Desktop app | [07-desktop-app.md](07-desktop-app.md) | Not started |
| 8 | Pilot, i18n and onboarding | [08-pilot-and-i18n.md](08-pilot-and-i18n.md) | Not started |
| 9 | Sponsor token pool | [09-sponsor-pool.md](09-sponsor-pool.md) | Not started (only if a sponsor materializes) |

## Dependency graph

```
0a ──► 0b ──► 1 ──► 2 ──► 3 ──► 6
              │     │
              │     ├──► 4 ──► 8 (pilot needs 2–5)
              │     │
              │     └──► 5 ──┘
              │
              └──► 7 (after 2 proves the UI; needs packages/ui)

9 sponsor pool: after everything else, only if a sponsor commits.
  Depends only on the ChatProvider interface (stage 1); nothing depends on it.
```

**Parallel tracks:**
- **Coach quality:** 1 → 3 → 6. Every prompt change goes through the eval suite.
- **FRC depth:** 4 and 5 can run in parallel once 2 lands.
- **Reach:** 7, then 8.
- **Pool:** 9 is a separate track that a separate contributor could own, and it is the last thing built.

## Conventions used across stages
- **Packages:** npm scope `@codecoach/*`. Each workspace package has `src/`, `test/`, and its own `tsconfig.json` referenced from the root `tsconfig.json`.
- **Tool names:** the model-facing tools are `snake_case` (`read_file`, `run_build`, `query_log`). Their JSON schemas are generated from Zod schemas in `packages/frc/src/tools/` or `packages/core/src/tools/`.
- **Team config:** `.codecoach/config.json` in the *robot* repo, validated by `packages/core/schema/config.schema.json` (generated from Zod).
- **Fixtures:** `fixtures/<lang>-<controller>-<bug>/`, e.g. `fixtures/java-roborio-default-command-bug/`. Every fixture has `scenario.yaml` (simulated student + expected diagnosis).
- **Pinned versions:** the root `package.json` (`packageManager`, `engines`) and `.node-version` are the only places tool versions are pinned. The NixHub flake follows them.
- **JDKs:** code never reads `JAVA_HOME` directly. It always goes through `packages/frc/src/jdk.ts`.
- **Branches:** one branch and one PR per task group in each doc's task breakdown.
- **verify:** text marked *verify* is a fact to confirm against the vendor docs (WPILib, CTRE, REV, the LLM providers) during that stage.
