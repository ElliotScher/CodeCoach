# Judge calibration

The LLM judge only counts if it agrees with people. Each file here is one person's grades for one eval transcript, made with:

```sh
pnpm codecoach eval grade packages/evals/runs/<run>/<scenario>.json
```

That shows the transcript and asks pass/fail for each rubric item (`packages/evals/rubric.md`). Grade without looking at the judge's result. Then:

```sh
pnpm codecoach eval calibrate
```

prints the per-item agreement between people and the judge. The target is at least 80% per item over at least 10 transcripts. Transcripts are copied next to the grades so the calibration set survives `runs/` being cleaned (runs are gitignored).
