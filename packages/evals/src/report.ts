import { promises as fs } from "node:fs";
import path from "node:path";

import { RUBRIC_ITEMS, RUBRIC_LABELS } from "./judge.js";
import type { EvalRun, ScenarioResult } from "./runner.js";

const mark = (v: boolean | null | undefined) => (v === null || v === undefined ? "–" : v ? "✓" : "✗");

/** Markdown score matrix for one run (one provider/model). */
export function renderReport(run: EvalRun): string {
  const rs = run.results;
  const lines: string[] = [];
  const hashes = [...new Set(rs.map((r) => r.promptHash))];
  lines.push(`# Eval run ${run.startedAt}`);
  lines.push("");
  lines.push(`- Coach: ${rs[0]?.provider ?? "?"} / ${run.model}`);
  lines.push(`- Prompt: ${[...new Set(rs.map((r) => r.promptVersions))].join(", ")} (hash ${hashes.join(", ")})`);
  lines.push(
    `- Scenarios: ${rs.length}${run.skipped.length ? ` (skipped for budget: ${run.skipped.join(", ")})` : ""}`,
  );
  lines.push(`- Total cost: $${run.totalUsd.toFixed(2)}`);
  lines.push("");
  const header = [
    "Scenario",
    "Level",
    ...RUBRIC_ITEMS.map((i) => `(${i})`),
    "Fix check",
    "Student",
    "Coach turns",
    "Turns to fix",
    "Discarded",
    "Shown viol.",
    "Rewrites",
    "Outside ws",
    "Cost",
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const r of rs) {
    const j = r.judge.output;
    lines.push(
      `| ${[
        r.id,
        r.level,
        ...RUBRIC_ITEMS.map((i) => mark(j?.[i].pass)),
        mark(r.metrics.fixCheck),
        r.studentStatus,
        r.metrics.coachTurns,
        r.metrics.turnsToFix ?? "–",
        r.metrics.guardViolations,
        r.metrics.violationsShown,
        r.metrics.rewrites,
        r.metrics.outsideWorkspaceCalls,
        `$${r.metrics.costUsd.total.toFixed(2)}`,
      ].join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push("## Pass rates");
  lines.push("");
  for (const i of RUBRIC_ITEMS) {
    const graded = rs.filter((r) => r.judge.output);
    const passed = graded.filter((r) => r.judge.output![i].pass).length;
    lines.push(`- (${i}) ${RUBRIC_LABELS[i]}: ${passed}/${graded.length}`);
  }
  const turns = rs.reduce((n, r) => n + r.metrics.coachTurns, 0);
  lines.push(
    `- Guardrail violations shown to the student: ${rs.reduce((n, r) => n + r.metrics.violationsShown, 0)} of ${turns} coach turns`,
  );
  lines.push(
    `- Turns discarded by the checker: ${rs.reduce((n, r) => n + r.metrics.guardViolations, 0)}; rewritten: ${rs.reduce((n, r) => n + r.metrics.rewrites, 0)}`,
  );
  lines.push(
    `- Tool calls refused for leaving the workspace: ${rs.reduce((n, r) => n + r.metrics.outsideWorkspaceCalls, 0)}`,
  );
  const errors = rs.filter((r) => r.error || r.judge.error);
  if (errors.length) {
    lines.push("");
    lines.push("## Errors");
    for (const r of errors) lines.push(`- ${r.id}: ${[r.error, r.judge.error].filter(Boolean).join("; ")}`);
  }
  lines.push("");
  lines.push("## Judge summaries");
  for (const r of rs) lines.push(`- **${r.id}**: ${r.judge.output?.summary ?? "(not graded)"}`);
  return `${lines.join("\n")}\n`;
}

export async function writeReport(run: EvalRun): Promise<string> {
  const file = path.join(run.dir, "summary.md");
  await fs.writeFile(file, renderReport(run));
  await fs.writeFile(
    path.join(run.dir, "run.json"),
    `${JSON.stringify({ ...run, results: run.results.map((r) => r.id) }, null, 2)}\n`,
  );
  return file;
}

/** Loads a run's scenario results back from disk (for calibration and re-reporting). */
export async function loadRun(dir: string): Promise<ScenarioResult[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && f !== "run.json").sort();
  return Promise.all(
    files.map(async (f) => JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as ScenarioResult),
  );
}
