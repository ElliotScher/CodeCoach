// A stand-in for `claude -p --input-format stream-json` in tests. For each user
// message on stdin it replays the next recorded fixture; an interrupt control
// request arriving mid-replay ends the turn the way Claude Code does.
// FAKE_CLAUDE_SCRIPT lists the fixtures (comma-separated); FAKE_CLAUDE_INIT_TOOLS
// overrides init's tools. With `--output-format json` it prints one result with
// structured_output.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[args.indexOf("--output-format") + 1] === "json") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  out({ type: "result", subtype: "success", is_error: false, result: "{}", structured_output: { echoed: input.trim() }, usage: { input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.001 });
  process.exit(0);
}

const script = (process.env.FAKE_CLAUDE_SCRIPT ?? "text-turn").split(",");
let turn = 0;
const state = { interrupted: false, replaying: Promise.resolve() };

async function replay(name) {
  state.interrupted = false;
  for (const raw of readFileSync(path.join(here, `${name}.jsonl`), "utf8").split("\n")) {
    if (!raw.trim()) continue;
    const d = JSON.parse(raw);
    if (d.type === "system" && d.subtype === "init" && process.env.FAKE_CLAUDE_INIT_TOOLS) d.tools = process.env.FAKE_CLAUDE_INIT_TOOLS.split(",");
    if (state.interrupted) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", usage: {} });
      return;
    }
    out(d);
    await new Promise((r) => setTimeout(r, 2)); // give the reader time to send an interrupt
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    state.interrupted = true;
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
  } else if (msg.type === "user") {
    const name = script[Math.min(turn++, script.length - 1)];
    state.replaying = state.replaying.then(() => replay(name));
  }
});
lines.on("close", () => state.replaying.then(() => process.exit(0)));
