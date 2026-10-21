/**
 * Words that tell a stuck student "you should already know this". The checker
 * flags them in prose (never inside code), with exceptions for harmless uses.
 */
export interface BannedPhrase {
  pattern: RegExp;
  phrase: string;
  /** What to say instead (used in the corrective note). */
  alternative: string;
  /** Matches inside these surroundings are allowed. */
  exceptions?: RegExp[];
}

export const BANNED_PHRASES: readonly BannedPhrase[] = [
  {
    pattern: /\bjust\b/i,
    phrase: "just",
    alternative: "drop it, or say what to do directly",
    exceptions: [/\bjust-in-time\b/i, /\bjust as\b/i, /\bjust like\b/i, /\bjust now\b/i],
  },
  { pattern: /\bsimply\b/i, phrase: "simply", alternative: "drop it" },
  { pattern: /\bobvious(ly)?\b/i, phrase: "obviously", alternative: 'drop it, or say "one thing to check is"' },
  {
    pattern: /\beasy\b/i,
    phrase: "easy",
    alternative: 'say "a small change" or "a quick check"',
    // "this isn't easy" normalizes struggle; that's the opposite of the problem.
    exceptions: [
      /\b(not|isn't|aren't|wasn't|n't|never)\s+(an?\s+|that\s+|always\s+)?easy\b/i,
      /\beasy to (miss|overlook|get wrong|mix up)\b/i,
    ],
  },
  {
    pattern: /\btrivial(ly)?\b/i,
    phrase: "trivial",
    alternative: 'say "a small change"',
    exceptions: [/\b(not|n't)\s+(a\s+)?trivial\b/i],
  },
  { pattern: /\bas everyone knows\b/i, phrase: "as everyone knows", alternative: "drop it" },
];

/** Prose with inline `code` spans removed, so API names don't trip the check. */
function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, " ");
}

export function findBannedPhrases(text: string): BannedPhrase[] {
  const prose = stripInlineCode(text);
  return BANNED_PHRASES.filter((b) => {
    const global = new RegExp(b.pattern.source, `${b.pattern.flags.replace("g", "")}g`);
    for (const m of prose.matchAll(global)) {
      const start = Math.max(0, m.index - 30);
      const window = prose.slice(start, m.index + m[0].length + 30);
      if (!b.exceptions?.some((e) => e.test(window))) return true;
    }
    return false;
  });
}
