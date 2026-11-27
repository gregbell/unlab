import { readFileSync } from "node:fs";

/** A recorded command set of `test/fixtures/scenarios`, as lines for the command bar, without its comments and blank lines. */
export function scenarioLines(name: string): string[] {
	const text = readFileSync(new URL(`../fixtures/scenarios/${name}.commands`, import.meta.url), "utf8");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

/** A line that waits until every machine is ready, as an agent waits on ls: a link needs ready machines, and exec types into them. */
export const waitsForMachines = (line: string): boolean => /^(link|exec) /.test(line);

/** A line that sets what a boot forgets, such as a route or forwarding in a guest. */
export const inGuests = (line: string): boolean => line.startsWith("exec ");
