import { describe, expect, test } from "vitest";

import pkg from "../package.json" with { type: "json" };
import { createProgram } from "../src/program.js";

describe("codecoach CLI", () => {
  test("--version prints the package version", async () => {
    let out = "";
    const program = createProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => (out += s) });
    await expect(program.parseAsync(["node", "codecoach", "--version"])).rejects.toMatchObject({
      code: "commander.version",
    });
    expect(out.trim()).toBe(pkg.version);
  });
});
