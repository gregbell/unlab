// Prints each Lab Command's synopsis, exactly as `help <command>` shows it, and its MCP tool.
// Run from the repo root: node --experimental-transform-types .agents/skills/manual-verify/scripts/usage.ts
import { VERBS } from "../../../../src/commands/index.ts";

for (const { manual } of VERBS) console.log(`${manual.usage}\t${manual.tool ?? "-"}`);
