// Throwaway. Prints the parts of unkernel's gateway that the relay depends on.   node sdk.mjs
import { readFileSync } from "node:fs";
const s = readFileSync(new URL("../../../node_modules/unkernel/dist/_chunks/core.mjs", import.meta.url), "utf8");
for (const [from, n] of [
	["class NetStack", 7000],
	["var NetStack", 7000],
	["function wispBackend", 5200],
	["function fetchRoutes", 3500],
]) {
	const i = s.indexOf(from);
	if (i < 0) console.log(`===== ${from}: not found`);
	else console.log(`\n===== ${from} @${i}\n${s.slice(Math.max(0, i - 900), i + n)}`);
}
