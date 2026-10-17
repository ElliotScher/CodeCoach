// Writes packages/core/schema/config.schema.json from the Zod TeamConfig schema.
// Run with `pnpm schema`; a test fails if the committed file is out of date.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { teamConfigJsonSchema } from "../src/config.js";

const out = fileURLToPath(new URL("../schema/config.schema.json", import.meta.url));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(teamConfigJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
