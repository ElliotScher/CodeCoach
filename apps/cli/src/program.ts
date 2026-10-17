import { Command, Option } from "commander";

import type { Effort, GuardrailLevel } from "@codecoach/core";

import pkg from "../package.json" with { type: "json" };
import { analyze } from "./commands/analyze.js";
import { chat } from "./commands/chat.js";
import { evalCalibrate, evalGrade, evalRun } from "./commands/eval.js";

const LEVELS = ["L0", "L1", "L2", "L3"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function createProgram(): Command {
  const program = new Command("codecoach")
    .description("Run CodeCoach against a robot project from a terminal.")
    .version(pkg.version, "-v, --version");

  program
    .command("chat")
    .description("Chat with the coach about a robot project")
    .requiredOption("-p, --project <dir>", "robot project folder")
    .addOption(new Option("--provider <provider>", "model provider").choices(["anthropic"]).default("anthropic"))
    .option("-m, --model <model>", "model (defaults to the team config, then claude-opus-5-5)")
    .addOption(
      new Option("-l, --level <level>", "guardrail level (overrides the team config, for testing)").choices(LEVELS),
    )
    .addOption(new Option("--effort <effort>", "model effort").choices(EFFORTS))
    .action(
      async (o: {
        project: string;
        provider: "anthropic";
        model?: string;
        level?: GuardrailLevel;
        effort?: Effort;
      }) => {
        await chat(o);
      },
    );

  program
    .command("analyze")
    .description("Print what CodeCoach detects about a project, and which JDK it needs")
    .argument("<dir>", "robot project folder")
    .option("--json", "machine-readable output")
    .action(async (dir: string, o: { json?: boolean }) => {
      await analyze(dir, o);
    });

  const evals = program.command("eval").description("Run the coaching eval suite (calls real models; costs money)");
  evals
    .command("run", { isDefault: true })
    .description("Run scenarios with a simulated student and an LLM judge")
    .option("-s, --scenarios <glob>", "only scenarios whose folder name matches this glob")
    .option("--smoke", "only the smoke subset")
    .option("-m, --model <model>", "coach model")
    .addOption(new Option("--effort <effort>", "coach effort").choices(EFFORTS))
    .option("--max-usd <usd>", "stop starting scenarios once this much is spent", (v) => Number(v), 10)
    .option("-y, --yes", "don't ask before spending")
    .action(
      async (o: {
        scenarios?: string;
        smoke?: boolean;
        model?: string;
        effort?: Effort;
        maxUsd: number;
        yes?: boolean;
      }) => {
        await evalRun(o);
      },
    );
  evals
    .command("grade")
    .description("Grade one eval transcript by hand, for judge calibration")
    .argument("<result>", "a packages/evals/runs/<run>/<scenario>.json file")
    .requiredOption("--grader <name>", "who is grading")
    .action(async (file: string, o: { grader: string }) => {
      await evalGrade(file, o);
    });
  evals
    .command("calibrate")
    .description("Show how often the judge agrees with human grades")
    .action(async () => {
      await evalCalibrate();
    });

  return program;
}
