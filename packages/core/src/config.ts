import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

/** Team configuration, committed with the robot repo as `.codecoach/config.json`. */
export const TeamConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    guardrailLevel: z
      .enum(["L0", "L1", "L2", "L3"])
      .default("L0")
      .describe("How much the coach may write: L0 Socratic (default) to L3 pair programmer."),
    providers: z
      .object({
        allowed: z
          .array(z.enum(["anthropic", "openai", "google"]))
          .min(1)
          .default(["anthropic"]),
        models: z.record(z.string(), z.string()).default({}).describe("Model override per provider."),
      })
      .default({ allowed: ["anthropic"], models: {} }),
    monthlyBudgetUsd: z
      .number()
      .positive()
      .optional()
      .describe("Stop before a call once this month's spend reaches this."),
    language: z.string().default("en").describe("Language the coach answers in (BCP 47)."),
    readingLevel: z.enum(["standard", "simplified"]).default("standard"),
  })
  .strict();

export type TeamConfig = z.infer<typeof TeamConfigSchema>;

export const DEFAULT_CONFIG: TeamConfig = TeamConfigSchema.parse({});

export const CONFIG_PATH = path.join(".codecoach", "config.json");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Loads the team config from a robot project, or the defaults if there is none. */
export async function loadTeamConfig(projectDir: string): Promise<TeamConfig> {
  const file = path.join(projectDir, CONFIG_PATH);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = TeamConfigSchema.safeParse(data);
  if (!parsed.success) throw new ConfigError(`${CONFIG_PATH} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** JSON Schema for editors, written to packages/core/schema/config.schema.json. */
export function teamConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TeamConfigSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
}
