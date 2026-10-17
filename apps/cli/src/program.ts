import { Command } from "commander";

import pkg from "../package.json" with { type: "json" };

export function createProgram(): Command {
  return new Command("codecoach")
    .description("Run CodeCoach against a robot project from a terminal.")
    .version(pkg.version, "-v, --version");
}
