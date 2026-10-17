#!/usr/bin/env node
// Replaces the synthetic SSE fixtures in test/fixtures/ with real recordings.
// Needs ANTHROPIC_API_KEY; makes two small requests (a few cents).
//   node packages/providers/scripts/record-fixtures.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
let next = null;
const recordingFetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  if (next) writeFileSync(path.join(out, next), text);
  return new Response(text, { status: res.status, headers: res.headers });
};
const client = new Anthropic({ fetch: recordingFetch });
const system = [
  { type: "text", text: "You are a robotics programming mentor. ".repeat(80), cache_control: { type: "ephemeral" } },
];
const tools = [
  {
    name: "read_file",
    description: "Read a file from the project.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    eager_input_streaming: true,
  },
];
const base = {
  model: "claude-opus-5-5",
  max_tokens: 4000,
  thinking: { type: "adaptive" },
  output_config: { effort: "low" },
  system,
  tools,
};
const messages = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "My robot won't drive. Read src/main/java/frc/robot/RobotContainer.java first.",
        cache_control: { type: "ephemeral" },
      },
    ],
  },
];

next = "turn1-tool-use.sse";
const first = await client.beta.messages.stream({ ...base, messages }).finalMessage();
const call = first.content.find((b) => b.type === "tool_use");
if (!call) throw new Error(`expected a tool call, got stop_reason=${first.stop_reason}`);
messages[0].content[0] = { type: "text", text: messages[0].content[0].text };
messages.push({ role: "assistant", content: first.content });
messages.push({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: call.id,
      content: "public class RobotContainer {}",
      cache_control: { type: "ephemeral" },
    },
  ],
});
next = "turn2-text.sse";
await client.beta.messages.stream({ ...base, messages }).finalMessage();
console.log(
  `Recorded turn1-tool-use.sse and turn2-text.sse in ${out}. Update the tests' expected text and usage to match.`,
);
