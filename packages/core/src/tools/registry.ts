import { z } from "zod";

import type { ToolSpec } from "../provider.js";
import type { GuardrailLevel, ToolCall, ToolResult } from "../types.js";
import { GUARDRAIL_LEVELS } from "../types.js";
import type { Workspace } from "../workspace.js";

/** What a tool can reach while it runs. */
export interface ToolContext {
  workspace: Workspace;
  signal: AbortSignal;
  /**
   * Ask the student before doing something with side effects (running a build).
   * Resolves false if there is nobody to ask.
   */
  confirm(question: string): Promise<boolean>;
  /** Streams long-running output (build logs) to the UI. */
  onOutput?(chunk: string): void;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Levels that register this tool. Defaults to every level. */
  levels?: readonly GuardrailLevel[];
  /** Read-only tools may run concurrently with each other. */
  readOnly: boolean;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}

/** Thrown by a tool to return a coaching-friendly error to the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: readonly ToolDefinition[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`tool names are snake_case: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  /**
   * The tools registered at `level`, sorted by name. Tools a level doesn't
   * allow are left out entirely, so the model never plans around them.
   */
  forLevel(level: GuardrailLevel): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => (t.levels ?? GUARDRAIL_LEVELS).includes(level))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  specs(level: GuardrailLevel): ToolSpec[] {
    return this.forLevel(level).map(toSpec);
  }

  /** Runs one call: unknown tools and invalid input become error results, never exceptions. */
  async execute(call: ToolCall, level: GuardrailLevel, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.forLevel(level).find((t) => t.name === call.name);
    if (!tool) return { callId: call.id, isError: true, content: `Unknown tool "${call.name}".` };
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      return {
        callId: call.id,
        isError: true,
        content: `Invalid input for ${call.name}: ${z.prettifyError(parsed.error)}`,
      };
    }
    try {
      return { callId: call.id, isError: false, content: await tool.run(parsed.data, ctx) };
    } catch (err) {
      if (ctx.signal.aborted) return { callId: call.id, isError: true, content: "Cancelled." };
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: call.id,
        isError: true,
        content: err instanceof ToolError ? message : `${call.name} failed: ${message}`,
      };
    }
  }

  /**
   * Runs a batch of calls from one assistant message. Read-only calls run
   * concurrently; the rest run in order after them. Results keep call order.
   */
  async executeAll(calls: readonly ToolCall[], level: GuardrailLevel, ctx: ToolContext): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length);
    const isReadOnly = (c: ToolCall) => this.tools.get(c.name)?.readOnly ?? true;
    await Promise.all(
      calls.map(async (c, i) => {
        if (isReadOnly(c)) results[i] = await this.execute(c, level, ctx);
      }),
    );
    for (const [i, c] of calls.entries()) {
      if (!isReadOnly(c)) results[i] = await this.execute(c, level, ctx);
    }
    return results;
  }
}

function toSpec(tool: ToolDefinition): ToolSpec {
  const schema = z.toJSONSchema(tool.input, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete schema["$schema"];
  return { name: tool.name, description: tool.description, inputSchema: schema };
}
