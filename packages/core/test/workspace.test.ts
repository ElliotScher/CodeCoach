import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { Workspace, WorkspaceError, globToRegExp } from "../src/index.js";

let root: string;
let outside: string;
let ws: Workspace;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ws-"));
  outside = mkdtempSync(path.join(os.tmpdir(), "outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "top secret\n");
  mkdirSync(path.join(root, "src/main/java/frc/robot"), { recursive: true });
  writeFileSync(
    path.join(root, "src/main/java/frc/robot/Robot.java"),
    "package frc.robot;\n\npublic class Robot {\n  int x = 1;\n}\n",
  );
  writeFileSync(path.join(root, "build.gradle"), "plugins {}\n");
  writeFileSync(path.join(root, ".env"), "KEY=1\n");
  writeFileSync(path.join(root, "team.pem"), "-----BEGIN-----\n");
  mkdirSync(path.join(root, ".codecoach"));
  writeFileSync(path.join(root, ".codecoach/config.json"), "{}");
  mkdirSync(path.join(root, "build/classes"), { recursive: true });
  writeFileSync(path.join(root, "build/classes/Robot.class"), "x");
  writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
  try {
    symlinkSync(outside, path.join(root, "escape"), "dir");
    symlinkSync(path.join(root, "src"), path.join(root, "inside-link"), "dir");
  } catch {
    // Symlinks may need privileges on Windows; those tests check for the link first.
  }
  ws = new Workspace(root);
});

describe("Workspace.resolve", () => {
  test.each(["../outside.txt", "src/../../x", path.join(os.tmpdir(), "not-in-root.txt")])(
    "refuses %s outside the root",
    async (p) => {
      await expect(ws.resolve(p)).rejects.toThrow(/outside the project/);
    },
  );

  test.each([
    ".env",
    ".env.local",
    "team.pem",
    "keys/deploy.KEY",
    ".codecoach/config.json",
    "build/classes/Robot.class",
    ".git/config",
  ])("denies %s", async (p) => {
    await expect(ws.resolve(p)).rejects.toBeInstanceOf(WorkspaceError);
  });

  test("refuses symlinks that point outside the root", async () => {
    if (!ws.isDenied("escape") && !(await exists(path.join(root, "escape")))) return;
    await expect(ws.resolve("escape/secret.txt")).rejects.toThrow(/links outside/);
  });

  test("allows normal files and in-root symlinks", async () => {
    await expect(ws.resolve("src/main/java/frc/robot/Robot.java")).resolves.toContain("Robot.java");
    if (await exists(path.join(root, "inside-link"))) {
      await expect(ws.resolve("inside-link/main")).resolves.toBeTruthy();
    }
  });
});

describe("Workspace file access", () => {
  test("lists files, skipping denied and escaping entries", async () => {
    const { files } = await ws.listFiles();
    expect(files).toContain("build.gradle");
    expect(files).toContain("src/main/java/frc/robot/Robot.java");
    for (const f of files) {
      expect(f).not.toMatch(/^(\.env|team\.pem|\.codecoach|build\/|escape)/);
    }
  });

  test("filters by glob", async () => {
    const { files } = await ws.listFiles(".", { glob: "*.java" });
    expect(files.every((f) => f.endsWith(".java"))).toBe(true);
  });

  test("reads line ranges and remembers what it read", async () => {
    const r = await ws.readFile("src/main/java/frc/robot/Robot.java", { startLine: 3, endLine: 4 });
    expect(r.text).toBe("public class Robot {\n  int x = 1;\n");
    expect(r.totalLines).toBe(6);
    expect(ws.hasSeenLine("int   x = 1;")).toBe(true);
    expect(ws.hasSeenLine("int y = 2;")).toBe(false);
  });

  test("refuses binary files", async () => {
    await expect(ws.readFile("image.bin")).rejects.toThrow(/binary/);
  });

  test("greps with a regex and reports line numbers", async () => {
    const { matches } = await ws.grep("class\\s+Robot");
    expect(matches).toEqual([{ path: "src/main/java/frc/robot/Robot.java", line: 3, text: "public class Robot {" }]);
  });

  test("rejects invalid regexes with a WorkspaceError", async () => {
    await expect(ws.grep("(")).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe("globToRegExp", () => {
  test.each([
    ["*.java", "src/a/B.java", true],
    ["*.java", "B.java", true],
    ["src/**/*.java", "src/B.java", true],
    ["src/**/*.java", "src/a/b/B.java", true],
    ["src/*.java", "src/a/B.java", false],
    ["vendordeps/*.json", "vendordeps/REVLib.json", true],
    ["**/*.{cpp,h}", "src/main/cpp/Robot.cpp", true],
    ["?.py", "a.py", true],
  ])("%s matches %s: %s", (glob, p, expected) => {
    expect(globToRegExp(glob).test(p)).toBe(expected);
  });
});

async function exists(p: string): Promise<boolean> {
  const { promises: fs } = await import("node:fs");
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}
