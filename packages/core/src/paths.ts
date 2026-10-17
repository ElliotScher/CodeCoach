import os from "node:os";
import path from "node:path";

/**
 * Where CodeCoach keeps local data (sessions, spend ledger). Conversations
 * never leave the student's machine; this is the only place they're stored.
 * CODECOACH_HOME overrides it (tests, portable installs).
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env["CODECOACH_HOME"]) return env["CODECOACH_HOME"];
  const home = os.homedir();
  if (platform === "win32") return path.join(env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "CodeCoach");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "CodeCoach");
  return path.join(env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"), "codecoach");
}
