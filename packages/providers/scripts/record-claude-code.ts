// Records real Claude Code stream-json output into test/fixtures/claude-code/.
// Uses a little of the signed-in Claude subscription (Haiku, two short turns).
//   node --conditions=@codecoach/source --import tsx packages/providers/scripts/record-claude-code.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { RuntimeAgent, ToolRegistry, Workspace, defineTool } from "@codecoach/core";

import { ClaudeCodeRuntime } from "../src/index.js";

const out = fileURLToPath(new URL("../test/fixtures/claude-code/", import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), "record-ws-"));
writeFileSync(path.join(dir, "notes.txt"), "Drivetrain needs a default command.\n");
const workspace = new Workspace(dir);
const readFile = defineTool({
  name: "read_file",
  description: "Read a file from the project.",
  input: z.object({ path: z.string() }),
  readOnly: true,
  run: async ({ path: p }, ctx) => (await ctx.workspace.readFile(p)).text,
});

/** Drops machine-specific fields before a line is committed as a fixture. */
function scrub(line: string): string {
  const d = JSON.parse(line) as Record<string, unknown>;
  for (const k of [
    "cwd",
    "original_cwd",
    "memory_paths",
    "messaging_socket_path",
    "slash_commands",
    "terminal_slash_commands",
    "skills",
    "agents",
    "plugins",
    "uuid",
    "session_id",
  ])
    delete d[k];
  return JSON.stringify(d);
}

let current: string[] = [];
const runtime = new ClaudeCodeRuntime({ model: "haiku", onRawLine: (l) => current.push(scrub(l)) });
const agent = new RuntimeAgent({
  runtime,
  system: "You are a test assistant. Use the read_file tool when asked about files. Reply in one short sentence.",
  tools: new ToolRegistry([readFile]),
  level: "L0",
  toolContext: { workspace, confirm: async () => false },
});
for (const [name, prompt] of [
  ["tool-turn", "Read notes.txt with the read_file tool and tell me what it says."],
  ["text-turn", "Thanks. Now say only: ok"],
] as const) {
  current = [];
  for await (const ev of agent.send({ text: prompt, escapeHatch: false }))
    if (ev.type === "text") process.stdout.write(ev.text);
  console.log();
  writeFileSync(path.join(out, `${name}.jsonl`), `${current.join("\n")}\n`);
}
await agent.close();
console.log(`Recorded fixtures in ${out}`);
