import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

import { globToRegExp } from "./glob.js";

/** Largest slice of a file the coach can read in one call. */
export const READ_CAP_BYTES = 200 * 1024;
const GREP_FILE_CAP_BYTES = 1024 * 1024;

/** Why a path is off limits. Checked on every path segment, relative to the root. */
const DENY_RULES: readonly { test: (segment: string, isLast: boolean) => boolean; reason: string }[] = [
  { test: (s) => s === ".codecoach", reason: "CodeCoach's own team settings are private" },
  { test: (s) => s === ".git", reason: "git internals are not project code" },
  { test: (s) => s === ".gradle" || s === "build", reason: "build output is generated, not source" },
  {
    test: (s) => s === "node_modules" || s === ".venv" || s === "__pycache__",
    reason: "installed packages are not project code",
  },
  { test: (s, last) => last && /^\.env/.test(s), reason: "environment files can contain secrets" },
  { test: (s, last) => last && /\.(pem|key)$/i.test(s), reason: "key files can contain secrets" },
];

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Sandboxed, read-only access to the student's project. Every path the model
 * supplies is resolved against the root; anything outside it (via `..`, an
 * absolute path or a symlink) or on the deny list is refused.
 */
export class Workspace {
  readonly root: string;
  /** Normalized lines of every file read this session (the checker lets these be quoted back). */
  private readonly seenLines = new Set<string>();
  private readonly readFiles = new Set<string>();

  constructor(root: string) {
    // The native realpath, like fs.promises.realpath used in resolve(): on
    // Windows the JavaScript realpathSync keeps 8.3 short names
    // (C:\Users\RUNNER~1) while the native one expands them, and mixing the
    // two makes every path look like it leaves the root.
    this.root = realpathSync.native(path.resolve(root));
  }

  /** Workspace-relative POSIX path for an absolute path inside the root. */
  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/") || ".";
  }

  /** Resolves a model-supplied path, or throws WorkspaceError explaining why not. */
  async resolve(input: string): Promise<string> {
    const lexical = path.resolve(this.root, input);
    const rel = path.relative(this.root, lexical);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new WorkspaceError(`"${input}" is outside the project folder.`);
    }
    this.checkDenied(rel);
    // Follow symlinks: the real location must still be inside the root.
    const real = await realpathOfNearestExisting(lexical);
    const realRel = path.relative(this.root, real);
    if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
      throw new WorkspaceError(`"${input}" links outside the project folder.`);
    }
    this.checkDenied(realRel);
    return lexical;
  }

  isDenied(rel: string): boolean {
    try {
      this.checkDenied(rel);
      return false;
    } catch {
      return true;
    }
  }

  private checkDenied(rel: string): void {
    if (!rel) return;
    const segments = rel.split(/[\\/]/);
    for (const [i, segment] of segments.entries()) {
      const rule = DENY_RULES.find((r) => r.test(segment, i === segments.length - 1));
      if (rule) throw new WorkspaceError(`"${segments.join("/")}" is off limits: ${rule.reason}.`);
    }
  }

  /** Lists files (not directories) under `dir`, optionally filtered by a glob. */
  async listFiles(
    dir = ".",
    opts: { glob?: string; max?: number } = {},
  ): Promise<{ files: string[]; truncated: boolean }> {
    const start = await this.resolve(dir);
    const matcher = opts.glob ? globToRegExp(opts.glob) : null;
    const max = opts.max ?? 500;
    const files: string[] = [];
    let truncated = false;
    const walk = async (abs: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        if (truncated) return;
        const childAbs = path.join(abs, e.name);
        const rel = this.relative(childAbs);
        if (this.isDenied(rel)) continue;
        if (e.isSymbolicLink()) {
          // List linked files that stay inside the root. Linked folders are
          // skipped: they duplicate real paths and can form cycles.
          try {
            await this.resolve(rel);
          } catch {
            continue;
          }
          const stat = await fs.stat(childAbs).catch(() => null);
          if (stat?.isFile()) push(rel);
        } else if (e.isDirectory()) {
          await walk(childAbs);
        } else if (e.isFile()) {
          push(rel);
        }
      }
    };
    const push = (rel: string) => {
      if (matcher && !matcher.test(rel)) return;
      if (files.length >= max) truncated = true;
      else files.push(rel);
    };
    await walk(start);
    return { files, truncated };
  }

  /** Reads a file (or a 1-based inclusive line range), capped at READ_CAP_BYTES. */
  async readFile(
    input: string,
    opts: { startLine?: number; endLine?: number } = {},
  ): Promise<{
    path: string;
    text: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
  }> {
    const abs = await this.resolve(input);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new WorkspaceError(`"${input}" does not exist.`);
    if (!stat.isFile()) throw new WorkspaceError(`"${input}" is a folder; use list_files instead.`);
    const content = await fs.readFile(abs, "utf8");
    if (content.includes("\u0000")) throw new WorkspaceError(`"${input}" is a binary file.`);
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, opts.startLine ?? 1);
    const endLine = Math.min(lines.length, opts.endLine ?? lines.length);
    let text = "";
    let last = startLine - 1;
    let truncated = false;
    for (let n = startLine; n <= endLine; n++) {
      const line = lines[n - 1]!;
      if (Buffer.byteLength(text) + Buffer.byteLength(line) + 1 > READ_CAP_BYTES) {
        truncated = true;
        break;
      }
      text += `${line}\n`;
      last = n;
      this.rememberLine(line);
    }
    this.readFiles.add(this.relative(abs));
    return { path: this.relative(abs), text, startLine, endLine: last, totalLines: lines.length, truncated };
  }

  /** Searches files with a JavaScript regular expression. */
  async grep(
    pattern: string,
    opts: { glob?: string; ignoreCase?: boolean; max?: number } = {},
  ): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
    } catch (err) {
      throw new WorkspaceError(`Invalid regular expression: ${(err as Error).message}`);
    }
    const max = opts.max ?? 100;
    const { files } = await this.listFiles(".", { max: 5000, ...(opts.glob ? { glob: opts.glob } : {}) });
    const matches: { path: string; line: number; text: string }[] = [];
    for (const rel of files) {
      const abs = path.join(this.root, rel);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || stat.size > GREP_FILE_CAP_BYTES) continue;
      const content = await fs.readFile(abs, "utf8").catch(() => "");
      if (content.includes("\u0000")) continue;
      const lines = content.split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        if (!re.test(line)) continue;
        if (matches.length >= max) return { matches, truncated: true };
        matches.push({ path: rel, line: i + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
        this.rememberLine(line);
      }
    }
    return { matches, truncated: false };
  }

  /** True if this exact line (whitespace-normalized) appeared in something the coach read. */
  hasSeenLine(line: string): boolean {
    return this.seenLines.has(normalizeLine(line));
  }

  get filesRead(): readonly string[] {
    return [...this.readFiles];
  }

  private rememberLine(line: string): void {
    const n = normalizeLine(line);
    if (n) this.seenLines.add(n);
  }
}

export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

async function realpathOfNearestExisting(abs: string): Promise<string> {
  let current = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}
