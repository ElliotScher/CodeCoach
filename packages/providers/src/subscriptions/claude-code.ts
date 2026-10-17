// Claude Code in headless mode, signed in with the project owner's Pro/Max
// subscription (stage 1b). DEVELOPMENT ONLY: third-party products can't offer
// claude.ai login without Anthropic's approval, so this is never shipped to
// students. Flags verified against Claude Code 2.1.301 (`claude --help`).
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { ProviderError } from "@codecoach/core";
import type {
  ChatEvent,
  ChatProvider,
  ChatRequest,
  ConversationRuntime,
  Effort,
  ModelInfo,
  RuntimeEvent,
  StopReason,
  ToolCall,
  ToolResult,
  ToolSpec,
  Usage,
  UsageLimitInfo,
} from "@codecoach/core";
import { SERVER_NAME, startHttpMcpServer } from "@codecoach/mcp-server";
import type { RunningMcpServer } from "@codecoach/mcp-server";

const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

/** The `claude` executable (CODECOACH_CLAUDE overrides it). */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env["CODECOACH_CLAUDE"] ?? "claude";
}

/**
 * The child's environment, with API-key credentials removed so Claude Code
 * can only use the subscription sign-in and can never bill an API key.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete out[k];
  return out;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
}

export class SubscriptionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionAuthError";
  }
}

/** Reads `claude auth status --json` (no model call). */
export function claudeAuthStatus(run: (cmd: string, args: string[]) => string = defaultRun): ClaudeAuthStatus | null {
  try {
    return JSON.parse(run(claudeBinary(), ["auth", "status", "--json"])) as ClaudeAuthStatus;
  } catch {
    return null;
  }
}

function defaultRun(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: subscriptionEnv(),
    timeout: 20_000,
    shell: process.platform === "win32",
  });
  if (r.error) throw r.error;
  return r.stdout;
}

/** Throws unless Claude Code is installed and signed in with a claude.ai subscription. */
export function assertSubscriptionAuth(status: ClaudeAuthStatus | null = claudeAuthStatus()): ClaudeAuthStatus {
  if (!status) {
    throw new SubscriptionAuthError(
      "Claude Code isn't installed or didn't answer. Install it, then run `claude` once to sign in.",
    );
  }
  if (!status.loggedIn)
    throw new SubscriptionAuthError("Claude Code isn't signed in. Run `claude` and sign in with your Pro/Max account.");
  if (status.authMethod !== "claude.ai") {
    throw new SubscriptionAuthError(
      `Claude Code is signed in with ${status.authMethod ?? "an unknown method"}, not a claude.ai subscription. CodeCoach doesn't use API keys; sign in with your Pro/Max account.`,
    );
  }
  return status;
}

export interface ClaudeCodeOptions {
  /** `opus`, `sonnet`, `haiku` or a full model name. */
  model?: string;
  effort?: Effort;
  /** Receives every raw stream-json line (debugging, recording fixtures). */
  onRawLine?: (line: string) => void;
  /** Skips the auth-status check (tests with a fake binary). */
  skipAuthCheck?: boolean;
  /** Command to run instead of `claude` (tests: [process.execPath, fakeScript]). */
  command?: readonly string[];
}

function commandFor(opts: { command?: readonly string[] }, args: string[]): [string, string[]] {
  const [cmd, ...pre] = opts.command ?? [claudeBinary()];
  return [cmd!, [...pre, ...args]];
}

const COMMON_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--no-session-persistence",
  // No user/project settings, plugins' slash commands or other MCP servers.
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
];

/** Arguments for a coaching runtime: CodeCoach's prompt, CodeCoach's MCP tools only, nothing else allowed. */
export function claudeCodeArgs(opts: { system: string; mcpConfig: unknown; model: string; effort?: Effort }): string[] {
  return [
    ...COMMON_ARGS,
    "--input-format",
    "stream-json",
    "--model",
    opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--mcp-config",
    JSON.stringify(opts.mcpConfig),
    // Built-in tools off: the coach can't read or edit files except through CodeCoach's sandboxed tools.
    "--tools",
    "",
    "--allowedTools",
    `mcp__${SERVER_NAME}`,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // Replaces Claude Code's own system prompt (not appended).
    "--system-prompt",
    opts.system,
  ];
}

interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function toUsage(u: StreamUsage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export interface InitInfo {
  tools: string[];
  mcpServers: { name: string; status: string }[];
  apiKeySource: string;
  model: string;
}

/** The parse of one stream-json line: runtime events, or the init record to validate. */
export type ParsedLine =
  { kind: "events"; events: RuntimeEvent[] } | { kind: "init"; init: InitInfo } | { kind: "ignore" };

function limitInfo(raw: Record<string, unknown>): UsageLimitInfo {
  const info: UsageLimitInfo = { status: String(raw["status"] ?? "unknown") };
  const windows = (raw["unifiedWindows"] ?? {}) as Record<string, { utilization?: number; resetsAt?: number }>;
  let worst: [string, { utilization?: number; resetsAt?: number }] | undefined;
  for (const entry of Object.entries(windows))
    if (!worst || (entry[1].utilization ?? 0) > (worst[1].utilization ?? 0)) worst = entry;
  if (worst) {
    if (worst[1].utilization !== undefined) info.utilization = worst[1].utilization;
    if (worst[1].resetsAt !== undefined) info.resetsAt = worst[1].resetsAt * 1000;
    info.window = worst[0];
  } else if (typeof raw["resetsAt"] === "number") {
    info.resetsAt = (raw["resetsAt"] as number) * 1000;
  }
  return info;
}

function resultStop(d: Record<string, unknown>): { stop: StopReason | "interrupted"; error?: ProviderError } {
  const subtype = String(d["subtype"] ?? "");
  if (subtype === "success") {
    const r = String(d["stop_reason"] ?? "end_turn");
    if (r === "refusal") return { stop: "refusal", error: new ProviderError("refusal", "Declined.") };
    return { stop: r === "max_tokens" ? "max_tokens" : "end_turn" };
  }
  if (d["terminal_reason"] === "aborted_streaming" || d["terminal_reason"] === "aborted")
    return { stop: "interrupted" };
  const status = d["api_error_status"];
  const message =
    typeof d["result"] === "string" && d["result"]
      ? (d["result"] as string)
      : `Claude Code stopped (${subtype}${status ? `, HTTP ${String(status)}` : ""}).`;
  return { stop: "error", error: new ProviderError(status === 429 ? "rate_limit" : "other", message, status === 429) };
}

/** Maps one line of Claude Code's stream-json output. Subagent output (parent_tool_use_id) is ignored. */
export function parseStreamLine(line: string): ParsedLine {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "ignore" };
  }
  if (d["parent_tool_use_id"]) return { kind: "ignore" };
  switch (d["type"]) {
    case "system":
      if (d["subtype"] !== "init") return { kind: "ignore" };
      return {
        kind: "init",
        init: {
          tools: (d["tools"] as string[] | undefined) ?? [],
          mcpServers: (d["mcp_servers"] as { name: string; status: string }[] | undefined) ?? [],
          apiKeySource: String(d["apiKeySource"] ?? ""),
          model: String(d["model"] ?? ""),
        },
      };
    case "stream_event": {
      const ev = d["event"] as { type: string; delta?: { type: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        return { kind: "events", events: [{ type: "text_delta", text: ev.delta.text }] };
      }
      return { kind: "ignore" };
    }
    case "assistant": {
      const content = ((d["message"] as { content?: unknown[] } | undefined)?.content ?? []) as {
        type: string;
        id?: string;
        name?: string;
        input?: unknown;
      }[];
      const events: RuntimeEvent[] = content
        .filter((c) => c.type === "tool_use" && c.id && c.name)
        .map((c) => ({
          type: "tool_start" as const,
          call: {
            id: c.id!,
            name: c.name!.startsWith(TOOL_PREFIX) ? c.name!.slice(TOOL_PREFIX.length) : c.name!,
            input: c.input ?? {},
          },
        }));
      return events.length ? { kind: "events", events } : { kind: "ignore" };
    }
    case "user": {
      const content = ((d["message"] as { content?: unknown } | undefined)?.content ?? []) as unknown;
      if (!Array.isArray(content)) return { kind: "ignore" };
      const events: RuntimeEvent[] = (
        content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]
      )
        .filter((c) => c.type === "tool_result" && c.tool_use_id)
        .map((c) => ({
          type: "tool_end" as const,
          callId: c.tool_use_id!,
          result: {
            callId: c.tool_use_id!,
            isError: Boolean(c.is_error),
            content: Array.isArray(c.content)
              ? (c.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("")
              : String(c.content ?? ""),
          },
        }));
      return events.length ? { kind: "events", events } : { kind: "ignore" };
    }
    case "rate_limit_event":
      return {
        kind: "events",
        events: [{ type: "limit", info: limitInfo((d["rate_limit_info"] ?? {}) as Record<string, unknown>) }],
      };
    case "result": {
      const { stop, error } = resultStop(d);
      const cost = d["total_cost_usd"];
      return {
        kind: "events",
        events: [
          {
            type: "turn_end",
            stop,
            usage: toUsage(d["usage"] as StreamUsage | undefined),
            ...(typeof cost === "number" ? { apiEquivalentUsd: cost } : {}),
            ...(error ? { error } : {}),
          },
        ],
      };
    }
    default:
      return { kind: "ignore" };
  }
}

/** Why an init record is unacceptable, or null if it's fine. */
export function checkInit(init: InitInfo, expectedTools: readonly string[]): string | null {
  if (init.apiKeySource !== "none") {
    return `Claude Code is using an API key (${init.apiKeySource}); CodeCoach only runs on a subscription sign-in.`;
  }
  const unexpected = init.tools.filter((t) => !t.startsWith(TOOL_PREFIX));
  if (unexpected.length) return `Claude Code's own tools are enabled (${unexpected.join(", ")}); refusing to run.`;
  const server = init.mcpServers.find((s) => s.name === SERVER_NAME);
  if (expectedTools.length && server?.status !== "connected")
    return `CodeCoach's tool server didn't connect (${server?.status ?? "missing"}).`;
  const missing = expectedTools.filter((t) => !init.tools.includes(TOOL_PREFIX + t));
  if (missing.length) return `Claude Code didn't load CodeCoach's tools: ${missing.join(", ")}.`;
  return null;
}

/** An async queue of runtime events for the turn in progress. */
class EventQueue {
  private items: RuntimeEvent[] = [];
  private waiting: ((v: RuntimeEvent | null) => void) | null = null;
  private closed = false;

  push(e: RuntimeEvent): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(e);
    } else this.items.push(e);
  }

  close(): void {
    this.closed = true;
    this.waiting?.(null);
    this.waiting = null;
  }

  next(): Promise<RuntimeEvent | null> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiting = resolve));
  }
}

/** A coaching session's Claude Code process, with CodeCoach's tools served to it over MCP. */
export class ClaudeCodeRuntime implements ConversationRuntime {
  readonly id = "claude-code";
  private child: ChildProcessWithoutNullStreams | null = null;
  private server: RunningMcpServer | null = null;
  private cwd: string | null = null;
  private queue: EventQueue | null = null;
  private expectedTools: string[] = [];
  private fatal: string | null = null;

  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async start(opts: {
    system: string;
    tools: ToolSpec[];
    callTool(call: ToolCall): Promise<ToolResult>;
  }): Promise<void> {
    if (!this.opts.skipAuthCheck) assertSubscriptionAuth();
    this.expectedTools = opts.tools.map((t) => t.name);
    this.server = await startHttpMcpServer({ tools: () => opts.tools, call: opts.callTool });
    // An empty working directory: no project CLAUDE.md, and the built-in file tools are off anyway.
    this.cwd = mkdtempSync(path.join(os.tmpdir(), "codecoach-claude-"));
    const args = claudeCodeArgs({
      system: opts.system,
      mcpConfig: this.server.mcpConfig(),
      model: this.opts.model ?? "opus",
      ...(this.opts.effort ? { effort: this.opts.effort } : {}),
    });
    const [cmd, fullArgs] = commandFor(this.opts, args);
    const child = spawn(cmd, fullArgs, {
      cwd: this.cwd,
      env: subscriptionEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-4000)));
    child.on("error", (err) => this.fail(`Couldn't start Claude Code (${claudeBinary()}): ${err.message}`));
    child.on("exit", (code) =>
      this.fail(
        `Claude Code exited (code ${code ?? "?"}).${stderr.trim() ? ` ${stderr.trim().split("\n").at(-1)}` : ""}`,
      ),
    );
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      this.opts.onRawLine?.(line);
      const parsed = parseStreamLine(line);
      if (parsed.kind === "init") {
        const problem = checkInit(parsed.init, this.expectedTools);
        if (problem) {
          this.fail(problem);
          child.kill();
        }
      } else if (parsed.kind === "events") {
        for (const e of parsed.events) this.queue?.push(e);
      }
    });
  }

  private fail(message: string): void {
    this.fatal ??= message;
    this.queue?.push({
      type: "turn_end",
      stop: "error",
      usage: toUsage(undefined),
      error: new ProviderError("other", this.fatal),
    });
    this.queue?.close();
  }

  async *turn(text: string, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (!this.child) throw new Error("ClaudeCodeRuntime.turn before start");
    if (this.fatal) {
      yield {
        type: "turn_end",
        stop: "error",
        usage: toUsage(undefined),
        error: new ProviderError("other", this.fatal),
      };
      return;
    }
    const queue = new EventQueue();
    this.queue = queue;
    const onAbort = () => void this.interrupt();
    signal.addEventListener("abort", onAbort, { once: true });
    this.child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
    );
    try {
      for (;;) {
        const e = await queue.next();
        if (!e) return;
        yield e;
        if (e.type === "turn_end") return;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.queue === queue) this.queue = null;
    }
  }

  async interrupt(): Promise<void> {
    this.child?.stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`,
    );
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.removeAllListeners("exit");
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.server?.close();
    this.server = null;
    if (this.cwd) rmSync(this.cwd, { recursive: true, force: true });
    this.cwd = null;
  }
}

/** Runs `claude -p` once with a prompt on stdin and returns its stdout. */
function runOnce(
  args: string[],
  input: string,
  opts: { signal?: AbortSignal | undefined; command?: readonly string[] | undefined },
): Promise<{ stdout: string; code: number | null; stderr: string }> {
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codecoach-claude-"));
    const [cmd, fullArgs] = commandFor(opts.command ? { command: opts.command } : {}, args);
    const child = spawn(cmd, fullArgs, { cwd, env: subscriptionEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    const kill = () => child.kill();
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      rmSync(cwd, { recursive: true, force: true });
      reject(new SubscriptionAuthError(`Couldn't start Claude Code (${claudeBinary()}): ${err.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ stdout, code, stderr });
    });
    child.stdin.end(input);
  });
}

function flatten(req: ChatRequest): string {
  if (req.messages.length === 1 && req.messages[0]!.role === "user") {
    return req.messages[0]!.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return req.messages
    .map((m) => `${m.role.toUpperCase()}:\n${m.content.map((p) => (p.type === "text" ? p.text : "")).join("")}`)
    .join("\n\n");
}

/**
 * A tool-less ChatProvider over one `claude -p` call per request, for cheap
 * sub-tasks such as rewriting a blocked reply into a hint.
 */
export class ClaudeCodeProvider implements ChatProvider {
  readonly id = "sub:claude-code" as const;
  readonly capabilities = { promptCaching: false, midConversationSystem: false, parallelTools: false, thinking: true };

  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async listModels(): Promise<ModelInfo[]> {
    return ["opus", "sonnet", "haiku"].map((id) => ({ id, displayName: `Claude ${id} (subscription)` }));
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    if (req.tools.length)
      throw new ProviderError(
        "bad_request",
        "ClaudeCodeProvider is for tool-less sub-tasks; use ClaudeCodeRuntime for coaching.",
      );
    if (!this.opts.skipAuthCheck) assertSubscriptionAuth();
    const args = [
      ...COMMON_ARGS,
      "--model",
      req.model || this.opts.model || "haiku",
      ...((req.effort ?? this.opts.effort) ? ["--effort", (req.effort ?? this.opts.effort)!] : []),
      "--tools",
      "",
      "--system-prompt",
      req.system.map((b) => b.text).join("\n\n"),
    ];
    const { stdout, code, stderr } = await runOnce(args, flatten(req), { signal, command: this.opts.command });
    let ended = false;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      this.opts.onRawLine?.(line);
      const parsed = parseStreamLine(line);
      if (parsed.kind === "init" && parsed.init.apiKeySource !== "none") {
        yield {
          type: "turn_end",
          stop: "error",
          usage: toUsage(undefined),
          raw: null,
          error: new ProviderError("auth", "Claude Code is using an API key; refusing."),
        };
        return;
      }
      if (parsed.kind !== "events") continue;
      for (const e of parsed.events) {
        if (e.type === "text_delta") yield e;
        else if (e.type === "turn_end") {
          ended = true;
          yield {
            type: "turn_end",
            stop: e.stop === "interrupted" ? "error" : e.stop,
            usage: e.usage,
            raw: null,
            ...(e.error ? { error: e.error } : {}),
          };
        }
      }
    }
    if (!ended) {
      yield {
        type: "turn_end",
        stop: "error",
        usage: toUsage(undefined),
        raw: null,
        error: new ProviderError(
          "other",
          `Claude Code exited (code ${code ?? "?"}) without a result. ${stderr.trim().split("\n").at(-1) ?? ""}`,
        ),
      };
    }
  }
}

/** One structured-output call (`--json-schema`), e.g. the eval judge. */
export async function claudeCodeJson(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  effort?: Effort;
  signal?: AbortSignal;
  skipAuthCheck?: boolean;
  command?: readonly string[];
}): Promise<{ output: unknown; usage: Usage; apiEquivalentUsd: number; error?: string }> {
  if (!opts.skipAuthCheck) assertSubscriptionAuth();
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--model",
    opts.model ?? "opus",
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--tools",
    "",
    "--system-prompt",
    opts.system,
    "--json-schema",
    JSON.stringify(opts.schema),
  ];
  const { stdout, code, stderr } = await runOnce(args, opts.prompt, { signal: opts.signal, command: opts.command });
  try {
    const r = JSON.parse(stdout) as {
      structured_output?: unknown;
      usage?: StreamUsage;
      total_cost_usd?: number;
      is_error?: boolean;
      result?: string;
    };
    return {
      output: r.structured_output ?? null,
      usage: toUsage(r.usage),
      apiEquivalentUsd: r.total_cost_usd ?? 0,
      ...(r.is_error || r.structured_output === undefined ? { error: r.result || "no structured output" } : {}),
    };
  } catch {
    return {
      output: null,
      usage: toUsage(undefined),
      apiEquivalentUsd: 0,
      error: `Claude Code exited (code ${code ?? "?"}): ${stderr.trim().split("\n").at(-1) ?? "no output"}`,
    };
  }
}
