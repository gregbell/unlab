// Breaks the behaviour each test is for, one break at a time, runs the tests, and puts the source back.
//
//   node .audit/phase2/topology-visuals/red.mjs [name ...]     every break in breaks.mjs, or those named
//   node .audit/phase2/topology-visuals/red.mjs --main         the map as it was at origin/main, under today's tests
//
// Each line it prints: what was broken | the tests that were run | their exit code | the tests that went red.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREAKS, MAIN } from "./breaks.mjs";

const only = process.argv.slice(2);
const out = join(tmpdir(), `topology-visuals-red-${process.pid}.json`);

function run({ kind, files, grep }) {
	const args = ["vitest", "run", "--project", kind, ...files, "--reporter=json", `--outputFile=${out}`, ...(grep ? ["-t", grep] : [])];
	const result = spawnSync("npx", args, { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
	let red = ["(no report)"];
	let ran = 0;
	try {
		const tests = JSON.parse(readFileSync(out, "utf8")).testResults.flatMap((file) => file.assertionResults);
		red = tests.filter((test) => test.status === "failed").map((test) => test.fullName);
		ran = tests.filter((test) => test.status !== "skipped" && test.status !== "pending").length;
	} catch {}
	rmSync(out, { force: true });
	return { code: result.status, red, ran };
}

/** The files as they are, the change made to them, and the tests under it. They are put back whatever happens. */
function under(name, changes, tests) {
	const kept = changes.map(({ file }) => ({ file, text: readFileSync(file, "utf8") }));
	try {
		for (const { file, text } of changes) writeFileSync(file, text);
		for (const test of tests) {
			const { code, red, ran } = run(test);
			const what = `${test.kind} ${test.files.join(" ")}${test.grep ? ` "${test.grep}"` : ""}`;
			console.log(`${name} | ${what} | exit ${code} | ${red.length ? `${red.length} of ${ran} red:\n    ${red.join("\n    ")}` : `STILL GREEN, all ${ran}`}`);
		}
	} finally {
		for (const { file, text } of kept) writeFileSync(file, text);
	}
}

if (only[0] === "--main") {
	under(
		`the map as at origin/main (${MAIN.commit})`,
		MAIN.files.map((file) => ({ file, text: execFileSync("git", ["show", `${MAIN.commit}:${file}`], { encoding: "utf8" }) })),
		MAIN.tests,
	);
} else {
	for (const { name, file, from, to, tests } of BREAKS) {
		if (only.length > 0 && !only.includes(name)) continue;
		const source = readFileSync(file, "utf8");
		if (!source.includes(from)) {
			console.log(`${name} | no such text in ${file}`);
			continue;
		}
		under(name, [{ file, text: source.replace(from, to) }], tests);
	}
}
