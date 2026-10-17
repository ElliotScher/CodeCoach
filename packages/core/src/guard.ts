/**
 * Hooks the agent loop uses to keep assistant turns inside the guardrail level.
 * The pedagogy package implements them; core only knows the shape.
 */

export interface Violation {
  /** e.g. "code_lines", "unfenced_code", "diff", "banned_phrase". */
  kind: string;
  message: string;
}

export interface GuardVerdict {
  /** Text that is safe to show now. */
  release: string;
  /** Set as soon as the turn breaks a rule; the turn is then discarded. */
  violations?: Violation[];
}

/** Checks one assistant turn incrementally as it streams. */
export interface StreamGuard {
  push(text: string): GuardVerdict;
  /** Called at the end of the turn: releases whatever is still held. */
  finish(): GuardVerdict;
}

export interface GuardHooks {
  start(): StreamGuard;
  /** System note sent with the retry after a violation. */
  correctiveNote(violations: readonly Violation[]): string;
  /** Rewrites a twice-failed draft into hint form (cheap model). Null if unavailable. */
  rewrite?(draft: string, violations: readonly Violation[], signal: AbortSignal): Promise<string | null>;
  /** Shown if the rewrite also fails or isn't available. */
  fallbackText: string;
}

/** A guard that releases everything immediately (tests, L3 without limits). */
export const PASSTHROUGH_GUARD: GuardHooks = {
  start: () => ({ push: (text) => ({ release: text }), finish: () => ({ release: "" }) }),
  correctiveNote: () => "",
  fallbackText: "",
};
