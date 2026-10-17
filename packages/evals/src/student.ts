import { promises as fs } from "node:fs";

import { z } from "zod";

import { Agent, ToolError, ToolRegistry, WorkspaceError, defineTool } from "@codecoach/core";
import type { AgentEvent, BudgetMeter, ChatProvider, Workspace } from "@codecoach/core";

import type { Scenario } from "./scenario.js";

export const SIMULATED_STUDENT_MODEL = "claude-sonnet-5-5";

export interface StudentEdit {
  file: string;
  before: string;
  after: string;
}

/** What the simulated student says it's doing, from a marker at the end of its message. */
export type StudentStatus = "talking" | "fixed" | "gave_up";

function studentSystemPrompt(s: Scenario): string {
  return [
    "You are role-playing a high-school student on an FRC robotics team, talking to a software mentor in a chat. This is an evaluation of the mentor, so play the student faithfully.",
    `Who you are: ${s.student.persona}.`,
    `Your problem, as you see it: ${s.student.opening}`,
    s.student.misconceptions.length ? `What you wrongly believe at first: ${s.student.misconceptions.join("; ")}.` : "",
    s.student.will_try.length ? `Things you'd try or suggest on your own: ${s.student.will_try.join("; ")}.` : "",
    `Your guess at the cause: ${s.student.reveals_hypothesis_when}.`,
    s.student.knows ? `Something you know if it comes up: ${s.student.knows}` : "",
    "",
    "How to play the student:",
    "- You do NOT know the real cause. Don't use expert knowledge beyond your persona. Only work out the problem from what the mentor tells you and what you see in your own code.",
    "- You can look at your project with view_file and list_files, as a student would in their editor. Do that when the mentor points you somewhere.",
    "- Only change code with edit_file once you understand from the mentor's hints what to change. Make the change yourself, in your own words and style. If the mentor writes the code for you, you may copy it.",
    "- Answer the mentor's questions honestly as this student. Keep messages short and in your persona's voice.",
    "- When you've made a change you believe fixes the robot, say so and end your message with [FIXED]. If you're completely stuck after several tries and want to stop, end with [GIVE UP].",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** A simulated student: an agent with the persona and a file view/edit tool on the scenario's project copy. */
export class SimulatedStudent {
  readonly edits: StudentEdit[] = [];
  private readonly agent: Agent;

  constructor(
    scenario: Scenario,
    opts: { provider: ChatProvider; model?: string; workspace: Workspace; budget?: BudgetMeter },
  ) {
    const edits = this.edits;
    const tools = new ToolRegistry([
      defineTool({
        name: "list_files",
        description: "List files in your robot project.",
        input: z.object({ glob: z.string().optional() }),
        readOnly: true,
        run: async ({ glob }, ctx) =>
          (await ctx.workspace.listFiles(".", { ...(glob ? { glob } : {}), max: 200 })).files.join("\n"),
      }),
      defineTool({
        name: "view_file",
        description: "Open a file from your robot project.",
        input: z.object({ path: z.string() }),
        readOnly: true,
        run: async ({ path: p }, ctx) => {
          try {
            return (await ctx.workspace.readFile(p)).text;
          } catch (err) {
            throw new ToolError((err as Error).message);
          }
        },
      }),
      defineTool({
        name: "edit_file",
        description: "Change your code: replace old_text (which must appear exactly once in the file) with new_text.",
        input: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
        readOnly: false,
        run: async ({ path: p, old_text, new_text }, ctx) => {
          let abs: string;
          try {
            abs = await ctx.workspace.resolve(p);
          } catch (err) {
            throw new ToolError(err instanceof WorkspaceError ? err.message : String(err));
          }
          const before = await fs.readFile(abs, "utf8");
          const count = before.split(old_text).length - 1;
          if (count !== 1) throw new ToolError(`old_text appears ${count} times in ${p}; it must appear exactly once.`);
          const after = before.replace(old_text, new_text);
          await fs.writeFile(abs, after, "utf8");
          edits.push({ file: ctx.workspace.relative(abs), before, after });
          return `Saved ${p}.`;
        },
      }),
    ]);
    this.agent = new Agent({
      provider: opts.provider,
      model: opts.model ?? SIMULATED_STUDENT_MODEL,
      effort: "low",
      maxTokens: 16000,
      system: [{ text: studentSystemPrompt(scenario), cacheBreakpoint: true }],
      tools,
      level: "L0",
      toolContext: { workspace: opts.workspace, confirm: async () => false },
      ...(opts.budget ? { budget: opts.budget } : {}),
    });
  }

  /** Gives the student the coach's reply; returns what the student says back. */
  async reply(
    coachText: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; status: StudentStatus; events: AgentEvent[] }> {
    const events: AgentEvent[] = [];
    let text = "";
    for await (const ev of this.agent.send({ text: coachText, escapeHatch: false }, signal)) {
      events.push(ev);
      if (ev.type === "text") text += ev.text;
    }
    text = text.trim();
    const status: StudentStatus = /\[FIXED\]\s*$/.test(text)
      ? "fixed"
      : /\[GIVE UP\]\s*$/.test(text)
        ? "gave_up"
        : "talking";
    return { text: text.replace(/\s*\[(FIXED|GIVE UP)\]\s*$/, ""), status, events };
  }
}
