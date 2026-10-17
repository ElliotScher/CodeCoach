import path from "node:path";

import { Workspace } from "@codecoach/core";
import {
  analyzeProject,
  renderJdkResolution,
  renderProjectSummary,
  renderStructure,
  requiredJdk,
  resolveJdk,
} from "@codecoach/frc";

/** `codecoach analyze <dir>`: the ProjectSummary, robot structure and JDK resolution. */
export async function analyze(dir: string, opts: { json?: boolean }): Promise<void> {
  const summary = await analyzeProject(new Workspace(path.resolve(dir)));
  const jdk =
    summary.language?.value === "python"
      ? null
      : resolveJdk(
          requiredJdk({
            controller: summary.controller?.value ?? null,
            toolchainVersion: summary.toolchainVersion?.value ?? null,
          }),
          summary.wpilibYear?.value ?? null,
        );
  if (opts.json) {
    console.log(JSON.stringify({ summary, jdk }, null, 2));
    return;
  }
  console.log(renderProjectSummary(summary));
  if (summary.structure) console.log(`\n${renderStructure(summary.structure)}`);
  if (jdk) console.log(`\nJDK:\n${renderJdkResolution(jdk)}`);
  if (jdk && !jdk.chosen) process.exitCode = 1;
}
