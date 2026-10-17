import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { Message, Usage } from "./types.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  projectRoot: string;
  provider: string;
  model: string;
  level: string;
  /** Content hash of the assembled prompt (tools + system), so transcripts tie to a prompt version. */
  promptHash: string;
}

export type SessionRecord =
  | { type: "meta"; meta: SessionMeta }
  | { type: "message"; message: Message }
  | { type: "state"; state: unknown }
  | { type: "usage"; usage: Usage; costUsd: number; model: string }
  | { type: "event"; name: string; data?: unknown };

/** An append-only JSONL session log. Records are never rewritten or removed. */
export class Session {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly meta: SessionMeta,
    readonly file: string,
  ) {}

  append(record: SessionRecord): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    // Serialize writes so records land in order.
    this.queue = this.queue.then(() => fs.appendFile(this.file, line, "utf8"));
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

export class SessionStore {
  constructor(readonly dir: string) {}

  async create(meta: Omit<SessionMeta, "id" | "createdAt">): Promise<Session> {
    await fs.mkdir(this.dir, { recursive: true });
    const full: SessionMeta = { id: randomUUID(), createdAt: new Date().toISOString(), ...meta };
    const session = new Session(full, path.join(this.dir, `${full.id}.jsonl`));
    await session.append({ type: "meta", meta: full });
    return session;
  }

  /** Replays a session: its meta, committed messages, latest coaching state and records. */
  async load(
    id: string,
  ): Promise<{ meta: SessionMeta; messages: Message[]; state: unknown; records: SessionRecord[] }> {
    const file = path.join(this.dir, `${id}.jsonl`);
    const records: SessionRecord[] = [];
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) records.push(JSON.parse(line) as SessionRecord);
    }
    const metaRecord = records.find((r): r is Extract<SessionRecord, { type: "meta" }> => r.type === "meta");
    if (!metaRecord) throw new Error(`session ${id} has no meta record`);
    const messages = records
      .filter((r): r is Extract<SessionRecord, { type: "message" }> => r.type === "message")
      .map((r) => r.message);
    const states = records.filter((r): r is Extract<SessionRecord, { type: "state" }> => r.type === "state");
    return { meta: metaRecord.meta, messages, state: states.at(-1)?.state ?? null, records };
  }

  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => e.slice(0, -".jsonl".length));
  }
}
