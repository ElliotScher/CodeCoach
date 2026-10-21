# Evals v1 baseline

**Status: not recorded yet.** The eval suite is built and tested offline (scripted providers). Under the project's spending policy (no API-key spending; PLAN.md, Decisions → Spending), the baseline is recorded through the Claude Code subscription transport from [stage 1b](../stages/01b-subscription-transport.md), with the coach, the simulated student and the judge all on the owner's Pro/Max subscription.

## How to record it

```sh
claude                                   # once: sign in with the Pro/Max account
pnpm codecoach eval --smoke              # 2 scenarios first
pnpm codecoach eval                      # all 8, spread across usage windows if needed
```

The run writes transcripts and `summary.md` to `packages/evals/runs/<timestamp>/` (gitignored). Copy the summary's score matrix and pass rates below, with the date, the transport, the model and the prompt hash.

Then calibrate the judge: grade at least 10 transcripts by hand with `pnpm codecoach eval grade <result.json> --grader <name>` and check that `pnpm codecoach eval calibrate` shows at least 80% agreement on every rubric item.

## What the baseline must show (stage 1 exit criteria)

- `java-roborio-default-command-bug` is coached to the fix without the coach handing it over.
- Guardrail violations shown to the student at L0: 0.
- Tool calls refused for leaving the workspace: 0.
- Judge agreement with human graders: at least 80% per item.

## Baseline

_Pending._
