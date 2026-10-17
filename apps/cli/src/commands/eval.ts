import { copyFileSync, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type { Effort } from "@codecoach/core";
import {
  RUBRIC_ITEMS,
  RUBRIC_LABELS,
  agreement,
  loadCalibration,
  loadScenarios,
  renderTranscript,
  runEvals,
  writeReport,
} from "@codecoach/evals";
import type { CalibrationEntry, RubricItem, ScenarioResult } from "@codecoach/evals";

import { bold, dim, red, yellow } from "../term.js";

/** Finds the repo root (the folder with pnpm-workspace.yaml) from the current directory. */
async function repoRoot(): Promise<string> {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (await fs.stat(path.join(dir, "pnpm-workspace.yaml")).catch(() => null)) return dir;
    if (path.dirname(dir) === dir) throw new Error("run this from inside the CodeCoach repo");
  }
}

/** Rough cost per scenario for the confirmation prompt (coach + student + judge). Measured runs replace this. */
const ESTIMATED_USD_PER_SCENARIO = 0.6;

export async function evalRun(opts: {
  scenarios?: string;
  smoke?: boolean;
  model?: string;
  effort?: Effort;
  maxUsd: number;
  yes?: boolean;
}): Promise<void> {
  const root = await repoRoot();
  const scenarios = await loadScenarios(path.join(root, "fixtures"), {
    ...(opts.scenarios ? { glob: opts.scenarios } : {}),
    ...(opts.smoke ? { smoke: true } : {}),
  });
  if (!scenarios.length) {
    console.error(red("No scenarios matched."));
    process.exitCode = 1;
    return;
  }
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    console.error(red("Evals call the Anthropic API: set ANTHROPIC_API_KEY."));
    process.exitCode = 1;
    return;
  }
  console.log(`${bold("Eval run")}: ${scenarios.length} scenario(s): ${scenarios.map((s) => s.id).join(", ")}`);
  console.log(
    `Calls real models (coach ${opts.model ?? "claude-opus-5-5"}, simulated student claude-sonnet-5-5, judge claude-opus-5-5). ` +
      `Rough estimate: $${(scenarios.length * ESTIMATED_USD_PER_SCENARIO).toFixed(2)}; stops starting new scenarios at $${opts.maxUsd.toFixed(2)}.`,
  );
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(yellow("Spend real money on this run? [y/N] "));
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Cancelled.");
      return;
    }
  }
  const run = await runEvals({
    scenarios,
    outDir: path.join(root, "packages/evals/runs"),
    maxUsd: opts.maxUsd,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    log: (l) => console.log(dim(l)),
  });
  const report = await writeReport(run);
  console.log(`\n${await fs.readFile(report, "utf8")}`);
  console.log(dim(`Transcripts and summary: ${run.dir}`));
}

/** `codecoach eval grade <result.json>`: a person grades one transcript for judge calibration. */
export async function evalGrade(file: string, opts: { grader: string }): Promise<void> {
  const root = await repoRoot();
  const result = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as ScenarioResult;
  console.log(bold(`${result.id} at ${result.level}`));
  console.log(dim("Grade the mentor against packages/evals/rubric.md without looking at the judge's result.\n"));
  console.log(renderTranscript(result.transcript));
  console.log(`\nFix check: ${result.metrics.fixCheck}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const human = {} as Record<RubricItem, boolean>;
  for (const item of RUBRIC_ITEMS) {
    for (;;) {
      const a = (await rl.question(`(${item}) ${RUBRIC_LABELS[item]}? [p]ass/[f]ail: `)).trim().toLowerCase();
      if (a === "p" || a === "f") {
        human[item] = a === "p";
        break;
      }
    }
  }
  const notes = (await rl.question("Notes (optional): ")).trim();
  rl.close();
  // Keep a copy of the transcript with the grades: runs/ is gitignored.
  const calDir = path.join(root, "packages/evals/calibration");
  mkdirSync(path.join(calDir, "results"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = path.join(calDir, "results", `${result.id}-${stamp}.json`);
  copyFileSync(path.resolve(file), copy);
  const entry: CalibrationEntry = {
    result: path.relative(root, copy).split(path.sep).join("/"),
    grader: opts.grader,
    gradedAt: new Date().toISOString(),
    human,
    ...(notes ? { notes } : {}),
  };
  const out = path.join(calDir, `${result.id}-${stamp}.json`);
  await fs.writeFile(out, `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`Saved ${path.relative(root, out)}`);
}

/** `codecoach eval calibrate`: agreement between human grades and the judge. */
export async function evalCalibrate(): Promise<void> {
  const root = await repoRoot();
  const pairs = await loadCalibration(path.join(root, "packages/evals/calibration"), root);
  if (!pairs.length) {
    console.log("No graded transcripts yet. Grade some with `pnpm codecoach eval grade <result.json>`.");
    return;
  }
  const rows = agreement(pairs.map((p) => ({ human: p.entry.human, judge: p.result.judge })));
  console.log(`${pairs.length} graded transcript(s) (target: at least 10, and 80% agreement per item):`);
  for (const r of rows) {
    const pct = Math.round(r.rate * 100);
    console.log(
      `  (${r.item}) ${RUBRIC_LABELS[r.item].padEnd(26)} ${r.agree}/${r.total}  ${pct >= 80 ? `${pct}%` : yellow(`${pct}%`)}`,
    );
  }
}
