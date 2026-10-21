import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { globToRegExp } from "@codecoach/core";

export const ScenarioSchema = z
  .object({
    id: z.string(),
    bug: z.string(),
    smoke: z.boolean().default(false),
    student: z.object({
      persona: z.string(),
      opening: z.string(),
      misconceptions: z.array(z.string()).default([]),
      will_try: z.array(z.string()).default([]),
      reveals_hypothesis_when: z.string(),
      /** Facts the student knows if asked (observations, history). */
      knows: z.string().optional(),
    }),
    environment: z.object({ hide_jdks: z.array(z.number().int()).default([]) }).default({ hide_jdks: [] }),
    expected: z.object({
      root_cause: z.string(),
      files: z.array(z.string()),
      level: z.enum(["L0", "L1", "L2", "L3"]),
      /** A regex that must match (or, with absent, must not match) the file once the bug is fixed. */
      fix_check: z.object({ file: z.string(), pattern: z.string(), absent: z.boolean().default(false) }).nullable(),
    }),
    max_turns: z.number().int().positive().default(12),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema> & { dir: string };

export async function loadScenario(dir: string): Promise<Scenario> {
  const file = path.join(dir, "scenario.yaml");
  const data = ScenarioSchema.safeParse(parseYaml(await fs.readFile(file, "utf8")));
  if (!data.success) throw new Error(`${file}: ${z.prettifyError(data.error)}`);
  if (data.data.id !== path.basename(dir)) throw new Error(`${file}: id "${data.data.id}" must match the folder name`);
  return { ...data.data, dir };
}

/** Every fixtures/<name>/scenario.yaml, optionally filtered by a glob on the name. */
export async function loadScenarios(
  fixturesDir: string,
  opts: { glob?: string; smoke?: boolean } = {},
): Promise<Scenario[]> {
  const names = (await fs.readdir(fixturesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const matcher = opts.glob ? globToRegExp(opts.glob) : null;
  const out: Scenario[] = [];
  for (const name of names) {
    const dir = path.join(fixturesDir, name);
    const exists = await fs.stat(path.join(dir, "scenario.yaml")).catch(() => null);
    if (!exists || (matcher && !matcher.test(name))) continue;
    const s = await loadScenario(dir);
    if (!opts.smoke || s.smoke) out.push(s);
  }
  return out;
}

/** Whether the scenario's fix check passes against a project directory. */
export async function fixCheckPasses(scenario: Scenario, projectDir: string): Promise<boolean | null> {
  const check = scenario.expected.fix_check;
  if (!check) return null;
  const text = await fs.readFile(path.join(projectDir, check.file), "utf8").catch(() => null);
  if (text === null) return false;
  const found = new RegExp(check.pattern, "m").test(text);
  return check.absent ? !found : found;
}
