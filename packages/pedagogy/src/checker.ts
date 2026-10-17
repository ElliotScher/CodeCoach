import type { GuardVerdict, GuardrailLevel, StreamGuard, Violation } from "@codecoach/core";
import { normalizeLine } from "@codecoach/core";

import { findBannedPhrases } from "./phrases.js";

export interface CheckContext {
  level: GuardrailLevel;
  /** Attempts the student has made (L2 allows snippets only after one). */
  attempts: number;
  /** True if this line exists in a file the coach read this session. */
  isStudentLine: (line: string) => boolean;
}

/** New-code line budget per turn, and whether pseudocode fences are free. */
export function levelLimits(ctx: Pick<CheckContext, "level" | "attempts">): {
  maxCodeLines: number;
  pseudoFree: boolean;
  unfencedAllowed: boolean;
} {
  switch (ctx.level) {
    case "L0":
      return { maxCodeLines: 2, pseudoFree: false, unfencedAllowed: false };
    case "L1":
      return { maxCodeLines: 0, pseudoFree: true, unfencedAllowed: false };
    case "L2":
      return { maxCodeLines: ctx.attempts >= 1 ? 8 : 0, pseudoFree: true, unfencedAllowed: false };
    case "L3":
      return { maxCodeLines: Number.POSITIVE_INFINITY, pseudoFree: true, unfencedAllowed: true };
  }
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const PSEUDO_TAGS = new Set(["text", "pseudo", "pseudocode", "plaintext", "txt"]);

/** Lines that look like code: ending in ; { or }, or a Python def/class header. */
export function looksLikeCode(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return (
    /[;{}]\s*$/.test(t) ||
    /^(def|class)\s+\w+.*:\s*$/.test(t) ||
    /^(#include|import\s+[\w.]+;|package\s+[\w.]+;)/.test(t)
  );
}

/** Lines that carry no code on their own: blank, comments, lone punctuation. */
function isTrivialLine(line: string): boolean {
  const t = line.trim();
  return !t || /^(\/\/|#(?!include)|\/\*|\*|\*\/)/.test(t) || /^[{}()[\];,.]+$/.test(t);
}

function countNewCodeLines(lines: readonly string[], ctx: CheckContext): number {
  return lines.filter((l) => !isTrivialLine(l) && !ctx.isStudentLine(normalizeLine(l))).length;
}

function looksLikeDiff(lines: readonly string[]): boolean {
  const hunks = lines.some((l) => /^@@ .* @@/.test(l));
  const changed = lines.filter((l) => /^[+-](?![+-])/.test(l) && l.length > 1).length;
  return hunks || (changed >= 2 && lines.some((l) => l.startsWith("+")) && lines.some((l) => l.startsWith("-")));
}

/**
 * Incremental response checker. Prose is released a sentence at a time after
 * the banned-phrase check; fenced code is held until the fence closes and then
 * counted; runs of unfenced code-like lines are held until it's clear whether
 * they reach 3 lines. The first violation stops the turn.
 */
export class ResponseChecker implements StreamGuard {
  private buf = "";
  private fence: { marker: string; lang: string; open: string; lines: string[] } | null = null;
  private held: string[] = [];
  private codeLinesUsed = 0;
  private failed: Violation[] | null = null;

  constructor(private readonly ctx: CheckContext) {}

  push(text: string): GuardVerdict {
    if (this.failed) return { release: "", violations: this.failed };
    this.buf += text;
    return this.process(false);
  }

  finish(): GuardVerdict {
    if (this.failed) return { release: "", violations: this.failed };
    return this.process(true);
  }

  private fail(violations: Violation[], release: string): GuardVerdict {
    this.failed = violations;
    return { release, violations };
  }

  private process(final: boolean): GuardVerdict {
    let out = "";
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const r = this.line(line);
      if (r.violations) return this.fail(r.violations, out + r.release);
      out += r.release;
    }
    if (final) {
      // Lines are released with a "\n"; the turn's last line may not have had one.
      const unterminated = this.buf !== "";
      if (unterminated) {
        const r = this.line(this.buf);
        this.buf = "";
        if (r.violations) return this.fail(r.violations, out + r.release);
        out += r.release;
      }
      if (this.fence) {
        // Unclosed fence at the end of the turn: check it as if it closed.
        const r = this.closeFence(null);
        if (r.violations) return this.fail(r.violations, out);
        out += r.release;
      }
      out += this.releaseHeld();
      if (unterminated && out.endsWith("\n")) out = out.slice(0, -1);
      return { release: out };
    }
    // Partial line: release whole sentences of prose, hold anything that might be code.
    if (!this.fence && !this.held.length && this.buf && !/^\s{0,3}[`~]/.test(this.buf)) {
      const cut = lastSentenceEnd(this.buf);
      if (cut > 0) {
        const sentence = this.buf.slice(0, cut);
        const banned = this.phraseViolations(sentence);
        if (banned) return this.fail(banned, out);
        this.buf = this.buf.slice(cut);
        out += sentence;
      }
    }
    return { release: out };
  }

  private line(line: string): GuardVerdict {
    if (this.fence) {
      if (new RegExp(`^\\s{0,3}${this.fence.marker[0]}{${this.fence.marker.length},}\\s*$`).test(line))
        return this.closeFence(line);
      this.fence.lines.push(line);
      return { release: "" };
    }
    const f = FENCE.exec(line);
    if (f) {
      const flushed = this.releaseHeld();
      this.fence = { marker: f[1]!, lang: f[2]!.toLowerCase(), open: line, lines: [] };
      return { release: flushed };
    }
    if (looksLikeCode(line) && !this.ctx.isStudentLine(normalizeLine(line))) {
      this.held.push(line);
      const { unfencedAllowed } = levelLimits(this.ctx);
      if (!unfencedAllowed && this.held.length >= 3) {
        return {
          release: "",
          violations: [
            { kind: "unfenced_code", message: "wrote code outside a code block (3 or more code-like lines)" },
          ],
        };
      }
      return { release: "" };
    }
    const flushed = this.releaseHeld();
    const banned = this.phraseViolations(line);
    if (banned) return { release: flushed, violations: banned };
    return { release: `${flushed}${line}\n` };
  }

  private closeFence(closing: string | null): GuardVerdict {
    const fence = this.fence!;
    this.fence = null;
    const { maxCodeLines, pseudoFree } = levelLimits(this.ctx);
    if (fence.lang === "diff" || looksLikeDiff(fence.lines)) {
      return {
        release: "",
        violations: [
          { kind: "diff", message: "showed a diff in the reply; changes go through propose_diff (L3 only)" },
        ],
      };
    }
    const isPseudo = PSEUDO_TAGS.has(fence.lang);
    if (!(isPseudo && pseudoFree)) {
      this.codeLinesUsed += countNewCodeLines(fence.lines, this.ctx);
      if (this.codeLinesUsed > maxCodeLines) {
        return {
          release: "",
          violations: [
            {
              kind: isPseudo ? "pseudocode" : "code_lines",
              message:
                maxCodeLines === 0
                  ? `showed ${this.codeLinesUsed} line(s) of new ${isPseudo ? "pseudo" : ""}code; ${this.ctx.level} allows none${this.ctx.level === "L2" ? " until the student has made an attempt" : ""}`
                  : `showed ${this.codeLinesUsed} lines of new code; ${this.ctx.level} allows at most ${maxCodeLines}`,
            },
          ],
        };
      }
    }
    const body = [fence.open, ...fence.lines, ...(closing !== null ? [closing] : [])].join("\n");
    return { release: `${body}\n` };
  }

  private releaseHeld(): string {
    if (!this.held.length) return "";
    const text = this.held.map((l) => `${l}\n`).join("");
    this.held = [];
    return text;
  }

  private phraseViolations(text: string): Violation[] | null {
    const hits = findBannedPhrases(text);
    if (!hits.length) return null;
    return hits.map((h) => ({ kind: "banned_phrase", message: `used "${h.phrase}" (${h.alternative})` }));
  }
}

/** Index just past the last sentence end (". ", "! ", "? ") in a partial line, or 0. */
function lastSentenceEnd(text: string): number {
  let cut = 0;
  for (const m of text.matchAll(/[.!?]["')\]]?\s+/g)) cut = m.index + m[0].length;
  return cut;
}

/** Checks a whole reply at once (rewrites, offline checks). */
export function checkResponse(text: string, ctx: CheckContext): { ok: boolean; violations: Violation[] } {
  const c = new ResponseChecker(ctx);
  const a = c.push(text);
  const b = a.violations ? a : c.finish();
  const violations = b.violations ?? [];
  return { ok: violations.length === 0, violations };
}
