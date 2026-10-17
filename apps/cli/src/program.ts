import { Command, Option } from "commander";

import pkg from "../package.json" with { type: "json" };
import { analyze } from "./commands/analyze.js";
import { chat } from "./commands/chat.js";
import type { ChatOptions } from "./commands/chat.js";
import { evalCalibrate, evalGrade, evalRun } from "./commands/eval.js";
import type { EvalRunOptions } from "./commands/eval.js";

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
    .addOption(
      new Option(
        "--provider <provider>",
        "claude-code: your Claude subscription (default); anthropic: the API (bills a key)",
      )
        .choices(["claude-code", "anthropic"])
        .default("claude-code"),
    )
    .option("--allow-api-spend", "allow --provider anthropic to bill an API key (off by project policy)")
    .option("-m, --model <model>", "model (claude-code: opus, sonnet or haiku; default opus)")
    .addOption(
      new Option("-l, --level <level>", "guardrail level (overrides the team config, for testing)").choices(LEVELS),
    )
    .addOption(new Option("--effort <effort>", "model effort").choices(EFFORTS))
    .action(async (o: ChatOptions) => {
      await chat(o);
    });

  program
    .command("analyze")
    .description("Print what CodeCoach detects about a project, and which JDK it needs")
    .argument("<dir>", "robot project folder")
    .option("--json", "machine-readable output")
    .action(async (dir: string, o: { json?: boolean }) => {
      await analyze(dir, o);
    });

  const evals = program.command("eval").description("Run the coaching eval suite (calls real models)");
  evals
    .command("run", { isDefault: true })
    .description("Run scenarios with a simulated student and an LLM judge (on your Claude subscription by default)")
    .option("-s, --scenarios <glob>", "only scenarios whose folder name matches this glob")
    .option("--smoke", "only the smoke subset")
    .addOption(
      new Option(
        "--provider <provider>",
        "claude-code: your Claude subscription (default); anthropic: the API (bills a key)",
      )
        .choices(["claude-code", "anthropic"])
        .default("claude-code"),
    )
    .option("--allow-api-spend", "allow --provider anthropic to bill an API key (off by project policy)")
    .option("-m, --model <model>", "coach model (claude-code default: opus)")
    .option("--student-model <model>", "simulated student model (claude-code default: sonnet)")
    .option("--judge-model <model>", "judge model (claude-code default: opus)")
    .addOption(new Option("--effort <effort>", "coach effort").choices(EFFORTS))
    .option("--max-usd <usd>", "API only: stop starting scenarios once this much is billed", (v) => Number(v), 10)
    .option("--resume <dir>", "finish a run that stopped (e.g. at a usage limit)")
    .option("-y, --yes", "don't ask before starting")
    .action(async (o: EvalRunOptions) => {
      await evalRun(o);
    });
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
