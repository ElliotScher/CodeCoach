import { z } from "zod";

import { ToolError, defineTool } from "@codecoach/core";
import type { ToolDefinition } from "@codecoach/core";

export const PHASES = [
  "idle",
  "describe",
  "hypothesize",
  "experiment",
  "observe",
  "refine",
  "fix",
  "reflect",
  "explain",
] as const;
export type Phase = (typeof PHASES)[number];

export interface CoachingState {
  phase: Phase;
  studentHypothesis: string | null;
  attempts: string[];
  concepts: string[];
  /** The student said they made the change (needed for fix → reflect). */
  studentMadeChange: boolean;
  /** The student asked to be told ("just tell me"); stays on until the explanation. */
  escapeHatch: boolean;
  /** Coach turns spent in `hypothesize`: the escape hatch needs at least one. */
  hypothesisPrompts: number;
}

export const INITIAL_STATE: CoachingState = {
  phase: "idle",
  studentHypothesis: null,
  attempts: [],
  concepts: [],
  studentMadeChange: false,
  escapeHatch: false,
  hypothesisPrompts: 0,
};

/** Allowed phase transitions (staying in the same phase is always allowed). */
const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  idle: ["describe", "hypothesize"],
  describe: ["hypothesize"],
  hypothesize: ["experiment", "observe", "describe"],
  experiment: ["observe", "hypothesize"],
  observe: ["refine", "fix", "hypothesize", "experiment"],
  refine: ["hypothesize", "experiment", "observe", "fix"],
  fix: ["reflect", "refine", "observe"],
  reflect: ["idle", "describe"],
  explain: ["fix", "reflect", "hypothesize"],
};

export interface StateUpdate {
  phase?: Phase;
  studentHypothesis?: string;
  attempt?: string;
  concepts?: string[];
  studentMadeChange?: boolean;
  newProblem?: boolean;
}

export type TransitionResult = { ok: true; state: CoachingState } | { ok: false; reason: string };

/** Validates and applies an update. Rejections carry a coaching reason for the model. */
export function applyUpdate(state: CoachingState, update: StateUpdate): TransitionResult {
  const next: CoachingState = update.newProblem ? { ...INITIAL_STATE, escapeHatch: state.escapeHatch } : { ...state };
  if (update.studentHypothesis !== undefined) {
    const h = update.studentHypothesis.trim();
    if (!h) return { ok: false, reason: "student_hypothesis is empty. Record the student's guess in their own words." };
    next.studentHypothesis = h;
  }
  if (update.attempt?.trim()) next.attempts = [...next.attempts, update.attempt.trim()];
  if (update.concepts?.length)
    next.concepts = [...new Set([...next.concepts, ...update.concepts.map((c) => c.trim()).filter(Boolean)])];
  if (update.studentMadeChange !== undefined) next.studentMadeChange = update.studentMadeChange;

  const target = update.phase;
  if (target && target !== next.phase) {
    if (target === "explain") {
      if (!next.escapeHatch) {
        return {
          ok: false,
          reason: "Only explain the cause when the student asks to be told. Keep coaching: ask for their guess.",
        };
      }
      if (next.hypothesisPrompts < 1 && !next.studentHypothesis) {
        return {
          ok: false,
          reason: "Ask the student for one guess first, even if it's \"I don't know\"; then you can explain.",
        };
      }
    } else if (!TRANSITIONS[next.phase].includes(target)) {
      return {
        ok: false,
        reason: `Can't go from ${next.phase} to ${target}. From ${next.phase} you can go to: ${TRANSITIONS[next.phase].join(", ")}.`,
      };
    }
    if ((target === "observe" || target === "fix") && !next.studentHypothesis) {
      return {
        ok: false,
        reason: "Ask the student for their hypothesis first. Record it with student_hypothesis before moving on.",
      };
    }
    if (target === "reflect" && next.phase === "fix" && !next.studentMadeChange) {
      return {
        ok: false,
        reason: "The student hasn't said they made the change yet. Ask them to try it and tell you what happened.",
      };
    }
    // The escape hatch is used up by the explanation.
    if (target === "explain") next.escapeHatch = false;
    next.phase = target;
  }
  return { ok: true, state: next };
}

/** Holds the session's coaching state and exposes it to the model as a tool. */
export class CoachingStateMachine {
  private current: CoachingState;

  constructor(initial: CoachingState = INITIAL_STATE) {
    this.current = { ...initial };
  }

  get state(): CoachingState {
    return this.current;
  }

  /** Called when a student turn starts. `escapeHatch` latches until the explanation. */
  beginStudentTurn(opts: { escapeHatch: boolean }): void {
    if (opts.escapeHatch) this.current = { ...this.current, escapeHatch: true };
  }

  /** Called after each committed coach turn. */
  endCoachTurn(): void {
    if (this.current.phase === "hypothesize") {
      this.current = { ...this.current, hypothesisPrompts: this.current.hypothesisPrompts + 1 };
    }
  }

  update(update: StateUpdate): TransitionResult {
    const r = applyUpdate(this.current, update);
    if (r.ok) this.current = r.state;
    return r;
  }

  tool(): ToolDefinition {
    return defineTool({
      name: "update_coaching_state",
      description:
        "Update the debugging session state: the current phase, the student's hypothesis (in their words), what they've tried, and concepts covered. The engine checks each phase change and explains any it refuses.",
      input: z.object({
        phase: z.enum(PHASES).optional().describe("The phase the conversation is moving to."),
        student_hypothesis: z.string().optional().describe("The student's own guess at the cause, in their words."),
        attempt: z.string().optional().describe("Something the student tried, to add to the list."),
        concepts: z.array(z.string()).optional().describe('Concepts covered, e.g. "default commands".'),
        student_made_change: z.boolean().optional().describe("True once the student says they made the change."),
        new_problem: z.boolean().optional().describe("True when the student moves on to a different problem."),
      }),
      readOnly: false,
      run: async (input) => {
        const update: StateUpdate = {
          ...(input.phase ? { phase: input.phase } : {}),
          ...(input.student_hypothesis !== undefined ? { studentHypothesis: input.student_hypothesis } : {}),
          ...(input.attempt ? { attempt: input.attempt } : {}),
          ...(input.concepts ? { concepts: input.concepts } : {}),
          ...(input.student_made_change !== undefined ? { studentMadeChange: input.student_made_change } : {}),
          ...(input.new_problem ? { newProblem: true } : {}),
        };
        const r = this.update(update);
        if (!r.ok) throw new ToolError(r.reason);
        return `State: phase=${r.state.phase}; hypothesis=${r.state.studentHypothesis ? JSON.stringify(r.state.studentHypothesis) : "none"}; attempts=${r.state.attempts.length}.`;
      },
    });
  }
}
