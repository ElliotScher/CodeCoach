import { promises as fs } from "node:fs";
import path from "node:path";

import type { Usage } from "./types.js";
import { ZERO_USAGE, addUsage } from "./types.js";

/** USD per million tokens. Cache writes are billed at 1.25× input (5-minute TTL). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
}

/** Anthropic first-party list prices (claude-api skill, cached 2026-10-06). Verify before relying on them. */
export const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

export function costUsd(model: string, usage: Usage): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.input * 1.25) /
    1_000_000
  );
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `This month's CodeCoach budget is used up ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}). ` +
        "Ask your mentor to raise monthlyBudgetUsd in .codecoach/config.json, or wait until next month.",
    );
    this.name = "BudgetExceededError";
  }
}

/** Tracks spend for this session and against the team's monthly cap. */
export class BudgetMeter {
  private session: Usage = ZERO_USAGE;
  private sessionUsd = 0;

  constructor(private readonly opts: { ledgerDir?: string; monthlyCapUsd?: number; now?: () => Date } = {}) {}

  get sessionUsage(): Usage {
    return this.session;
  }

  get sessionCostUsd(): number {
    return this.sessionUsd;
  }

  /** Throws BudgetExceededError if the monthly cap is already reached. Call before each provider call. */
  async check(): Promise<void> {
    const cap = this.opts.monthlyCapUsd;
    if (cap === undefined) return;
    const spent = await this.monthSpent();
    if (spent >= cap) throw new BudgetExceededError(spent, cap);
  }

  async record(model: string, usage: Usage): Promise<number> {
    const usd = costUsd(model, usage);
    this.session = addUsage(this.session, usage);
    this.sessionUsd += usd;
    if (this.opts.ledgerDir) {
      const file = this.ledgerFile();
      const spent = await this.monthSpent();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify({ usd: spent + usd })}\n`, "utf8");
    }
    return usd;
  }

  async monthSpent(): Promise<number> {
    if (!this.opts.ledgerDir) return this.sessionUsd;
    try {
      const data = JSON.parse(await fs.readFile(this.ledgerFile(), "utf8")) as { usd?: number };
      return data.usd ?? 0;
    } catch {
      return 0;
    }
  }

  private ledgerFile(): string {
    const d = (this.opts.now ?? (() => new Date()))();
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return path.join(this.opts.ledgerDir!, `spend-${month}.json`);
  }
}
