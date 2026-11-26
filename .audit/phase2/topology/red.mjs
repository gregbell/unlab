// Breaks the behaviour each test is for, one break at a time, runs the tests, and puts the source back.
//
//   node .audit/phase2/topology/red.mjs [name ...]     every break in breaks.mjs, or those named
//   KINDS=unit,browser node …/red.mjs                         only the tests of those kinds
//
// Each line it prints: what was broken | the tests that were run | their exit code | the tests that went red.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREAKS } from "./breaks.mjs";

const only = process.argv.slice(2);
const kinds = process.env.KINDS?.split(",");
const out = join(tmpdir(), `topology-red-${process.pid}.json`);

/** The titles that failed, as the reporter wrote them. */
function failedIn(kind) {
	const report = JSON.parse(readFileSync(out, "utf8"));
	if (kind === "e2e") {
		const titles = [];
		const walk = (suite) => {
			for (const spec of suite.specs ?? []) if (!spec.ok) titles.push(spec.title);
			for (const child of suite.suites ?? []) walk(child);
		};
		for (const suite of report.suites) walk(suite);
		return titles;
	}
	return report.testResults.flatMap((file) =>
		file.assertionResults.filter((a) => a.status === "failed").map((a) => a.title),
	);
}

function run({ kind, files, grep }) {
	const args =
		kind === "e2e"
			? ["playwright", "test", ...files, "--reporter=json", ...(grep ? ["-g", grep] : [])]
			: ["vitest", "run", "--project", kind, ...files, "--reporter=json", `--outputFile=${out}`, ...(grep ? ["-t", grep] : [])];
	const env = kind === "e2e" ? { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out } : process.env;
	const result = spawnSync("npx", args, { encoding: "utf8", env, stdio: ["ignore", "ignore", "ignore"] });
	let red = [];
	try {
		red = failedIn(kind);
	} catch {
		red = ["(no report)"];
	}
	rmSync(out, { force: true });
	return { code: result.status, red };
}

for (const { name, file, from, to, tests } of BREAKS) {
	if (only.length > 0 && !only.includes(name)) continue;
	const source = readFileSync(file, "utf8");
	if (!source.includes(from)) {
		console.log(`${name} | no such text in ${file}`);
		continue;
	}
	writeFileSync(file, source.replace(from, to));
	try {
		for (const test of tests) {
			if (kinds && !kinds.includes(test.kind)) continue;
			const { code, red } = run(test);
			const what = `${test.kind} ${test.files.join(" ")}${test.grep ? ` "${test.grep}"` : ""}`;
			console.log(`${name} | ${what} | exit ${code} | ${red.length ? `red: ${red.join(" ;; ")}` : "STILL GREEN"}`);
		}
	} finally {
		writeFileSync(file, source);
	}
}
