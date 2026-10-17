import { promises as fs } from "node:fs";
import path from "node:path";

import { RUBRIC_ITEMS } from "./judge.js";
import type { RubricItem } from "./judge.js";
import type { ScenarioResult } from "./runner.js";

/** A human's grades for one eval transcript, stored in packages/evals/calibration/. */
export interface CalibrationEntry {
  /** Eval result file the grades refer to, relative to the repo root. */
  result: string;
  grader: string;
  gradedAt: string;
  human: Record<RubricItem, boolean>;
  notes?: string;
}

export interface Agreement {
  item: RubricItem;
  agree: number;
  total: number;
  rate: number;
}

/** Per-item agreement between human grades and the judge (target ≥ 80%). */
export function agreement(
  pairs: readonly { human: Record<RubricItem, boolean>; judge: ScenarioResult["judge"] }[],
): Agreement[] {
  return RUBRIC_ITEMS.map((item) => {
    const graded = pairs.filter((p) => p.judge.output);
    const agree = graded.filter((p) => p.judge.output![item].pass === p.human[item]).length;
    return { item, agree, total: graded.length, rate: graded.length ? agree / graded.length : 0 };
  });
}

export async function loadCalibration(
  dir: string,
  repoRoot: string,
): Promise<{ entry: CalibrationEntry; result: ScenarioResult }[]> {
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  const out: { entry: CalibrationEntry; result: ScenarioResult }[] = [];
  for (const f of files) {
    const entry = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as CalibrationEntry;
    const result = JSON.parse(await fs.readFile(path.join(repoRoot, entry.result), "utf8")) as ScenarioResult;
    out.push({ entry, result });
  }
  return out;
}
