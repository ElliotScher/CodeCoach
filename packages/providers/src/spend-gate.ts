/**
 * The spending gate (PLAN.md, Decisions → Spending): adapters that bill an API
 * key refuse to run unless spending is explicitly opted in. Development and
 * evals use the Claude Code subscription transport instead.
 */
export const SPEND_ENV = "CODECOACH_ALLOW_API_SPEND";

export class ApiSpendingDisabledError extends Error {
  constructor(what: string) {
    super(
      `${what} bills an API key, and API spending is off for this project. ` +
        `Use the Claude Code subscription transport (--provider claude-code), or opt in with --allow-api-spend / ${SPEND_ENV}=1.`,
    );
    this.name = "ApiSpendingDisabledError";
  }
}

export function apiSpendAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SPEND_ENV] === "1";
}

/** Throws unless API spending is allowed explicitly (`allow`) or through the environment. */
export function assertApiSpendAllowed(what: string, allow?: boolean): void {
  if (!(allow ?? apiSpendAllowed())) throw new ApiSpendingDisabledError(what);
}
