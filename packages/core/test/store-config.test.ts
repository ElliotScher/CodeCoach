import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BudgetMeter,
  ConfigError,
  DEFAULT_CONFIG,
  SessionStore,
  costUsd,
  dataDir,
  loadTeamConfig,
  teamConfigJsonSchema,
} from "../src/index.js";

describe("SessionStore", () => {
  test("appends records and replays them in order", async () => {
    const store = new SessionStore(mkdtempSync(path.join(os.tmpdir(), "sessions-")));
    const s = await store.create({
      projectRoot: "/p",
      provider: "anthropic",
      model: "m",
      level: "L0",
      promptHash: "abc",
    });
    await s.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    await s.append({ type: "state", state: { phase: "describe" } });
    await s.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
    await s.append({ type: "state", state: { phase: "hypothesize" } });
    const loaded = await store.load(s.meta.id);
    expect(loaded.meta.promptHash).toBe("abc");
    expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(loaded.state).toEqual({ phase: "hypothesize" });
    expect(await store.list()).toEqual([s.meta.id]);
  });
});

describe("team config", () => {
  const project = () => mkdtempSync(path.join(os.tmpdir(), "proj-"));
  const write = (dir: string, data: string) => {
    mkdirSync(path.join(dir, ".codecoach"), { recursive: true });
    writeFileSync(path.join(dir, ".codecoach/config.json"), data);
  };

  test("defaults to L0 with Anthropic when there is no config", async () => {
    const config = await loadTeamConfig(project());
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.guardrailLevel).toBe("L0");
  });

  test("fills defaults for missing fields", async () => {
    const dir = project();
    write(dir, JSON.stringify({ guardrailLevel: "L2", monthlyBudgetUsd: 20 }));
    expect(await loadTeamConfig(dir)).toMatchObject({ guardrailLevel: "L2", monthlyBudgetUsd: 20, language: "en" });
  });

  test.each([
    ["not json", "{"],
    ["unknown level", JSON.stringify({ guardrailLevel: "L9" })],
    ["unknown field", JSON.stringify({ guardrailLevl: "L1" })],
  ])("rejects %s", async (_, data) => {
    const dir = project();
    write(dir, data);
    await expect(loadTeamConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  test("emits a JSON schema", () => {
    const schema = teamConfigJsonSchema();
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(schema["properties"] as object)).toContain("guardrailLevel");
  });
});

describe("budget", () => {
  test("prices cache reads and writes", () => {
    const usd = costUsd("claude-opus-5-5", {
      inputTokens: 1e6,
      outputTokens: 1e6,
      cacheReadTokens: 1e6,
      cacheWriteTokens: 1e6,
    });
    expect(usd).toBeCloseTo(4 + 20 + 0.2 + 5);
  });

  test("persists monthly spend across meters", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
    const now = () => new Date("2026-10-17T12:00:00Z");
    await new BudgetMeter({ ledgerDir: dir, now }).record("claude-opus-5-5", {
      inputTokens: 1e6,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(await new BudgetMeter({ ledgerDir: dir, now }).monthSpent()).toBeCloseTo(4);
    expect(await new BudgetMeter({ ledgerDir: dir, now: () => new Date("2026-11-01T00:00:00Z") }).monthSpent()).toBe(0);
  });
});

describe("dataDir", () => {
  test("honors CODECOACH_HOME and picks per-OS defaults", () => {
    expect(dataDir({ CODECOACH_HOME: "/x" })).toBe("/x");
    expect(dataDir({ XDG_DATA_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "codecoach"));
    expect(dataDir({ APPDATA: "C:\\Users\\s\\AppData\\Roaming" }, "win32")).toContain("CodeCoach");
  });
});

describe("config.schema.json", () => {
  test("is up to date (run `pnpm schema` after changing TeamConfigSchema)", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(committed).toEqual(teamConfigJsonSchema());
  });
});
