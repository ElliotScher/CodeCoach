import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";

import type { AgentEvent, Effort, GuardrailLevel } from "@codecoach/core";
import { ProviderError } from "@codecoach/core";

import { startSession } from "../session.js";
import { bold, cyan, dim, green, italic, red, yellow } from "../term.js";

export interface ChatOptions {
  project: string;
  provider: "anthropic";
  model?: string;
  level?: GuardrailLevel;
  effort?: Effort;
}

const HELP = `Commands:
  /hint      ask for a hint
  /tell-me   ask the coach to tell you (it asks for one guess first)
  /state     show the debugging state
  /cost      show this session's token use and cost
  /help      show this list
  /quit      leave (Ctrl+D works too)`;

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
      return `reading ${String(i["path"])}`;
    case "list_files":
      return `listing ${String(i["glob"] ?? i["dir"] ?? ".")}`;
    case "grep":
      return `searching for /${String(i["pattern"])}/`;
    case "outline_symbols":
      return `outlining ${String(i["path"])}`;
    case "update_coaching_state":
      return `noting: ${Object.entries(i)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")}`;
    default:
      return name.replace(/_/g, " ");
  }
}

export async function chat(opts: ChatOptions): Promise<void> {
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    console.error(
      red(
        "No Anthropic API key found. Set ANTHROPIC_API_KEY (the coach sends your messages and the code it reads to Anthropic).",
      ),
    );
    process.exitCode = 1;
    return;
  }
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  let turnController: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (turnController) {
      turnController.abort();
      process.stdout.write(dim("\n(stopped)\n"));
    } else {
      rl.close();
    }
  });

  const started = await startSession({
    ...opts,
    confirm: async (question) => {
      const answer = await rl.question(yellow(`\n${question} [y/N] `));
      return /^y(es)?$/i.test(answer.trim());
    },
    onOutput: (chunk) => process.stdout.write(dim(chunk)),
    onProposedDiff: (p) => process.stdout.write(`\n${bold(`Proposed change to ${p.file}:`)} ${p.summary}\n${p.diff}\n`),
  });
  const { coach, summary, budget, level, levelFromConfig, model } = started;

  console.log(bold("CodeCoach") + dim(` (session ${started.session.meta.id})`));
  console.log(
    dim(
      `Project: ${summary.language?.value ?? "unknown language"}, ${summary.controller?.value ?? "unknown controller"}, WPILib ${summary.wpilibYear?.value ?? "?"}. ` +
        `Guardrail level ${level}${level !== levelFromConfig ? ` (overriding the team's ${levelFromConfig})` : ""}.`,
    ),
  );
  console.log(
    dim(
      `Your messages and the project files the coach reads go to Anthropic (${model}). Nothing else leaves this computer.`,
    ),
  );
  console.log(dim("Type /help for commands.\n"));

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(cyan("you> "))).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;
    let text = line;
    let escapeHatch = false;
    if (line.startsWith("/")) {
      const cmd = line.split(/\s+/)[0]!;
      if (cmd === "/quit" || cmd === "/exit") break;
      if (cmd === "/help") {
        console.log(HELP);
        continue;
      }
      if (cmd === "/state") {
        console.log(JSON.stringify(coach.state.state, null, 2));
        continue;
      }
      if (cmd === "/cost") {
        const u = budget.sessionUsage;
        console.log(
          `${u.inputTokens} input, ${u.outputTokens} output, ${u.cacheReadTokens} cache-read, ${u.cacheWriteTokens} cache-write tokens; $${budget.sessionCostUsd.toFixed(4)}`,
        );
        continue;
      }
      if (cmd === "/hint") text = line.slice(cmd.length).trim() || "Can I have a hint?";
      else if (cmd === "/tell-me") {
        text = line.slice(cmd.length).trim() || "Can you tell me what's wrong?";
        escapeHatch = true;
      } else {
        console.log(`Unknown command ${cmd}. ${HELP}`);
        continue;
      }
    }

    turnController = new AbortController();
    process.stdout.write(green("coach> "));
    try {
      for await (const ev of coach.send(text, { escapeHatch, signal: turnController.signal })) render(ev);
    } catch (err) {
      console.error(red(`\n${err instanceof ProviderError ? err.message : String(err)}`));
    } finally {
      turnController = null;
    }
    process.stdout.write("\n\n");
  }
  rl.close();
  await started.session.flush();
  console.log(dim(`Session saved as ${started.session.file}`));
}

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      break;
    case "tool_start":
      process.stdout.write(dim(`\n  · ${describeTool(ev.call.name, ev.call.input)}\n`));
      break;
    case "tool_end":
      if (ev.result.isError) process.stdout.write(dim(`    (${ev.result.content.split("\n")[0]})\n`));
      break;
    case "notice":
      process.stdout.write(`\n${ev.kind === "error" ? red(ev.message) : italic(ev.message)}\n`);
      break;
    case "turn_end":
      if (ev.costUsd > 0) process.stdout.write(dim(`\n  [$${ev.costUsd.toFixed(4)}]`));
      break;
  }
}
