// Groups the sections that differ between two outputs of .audit/phase2/surface.mjs by the lines that differ, so that
// each kind of change is read once.
//
//   node --experimental-transform-types .audit/phase2/surface.mjs <old checkout> > before.txt
//   node --experimental-transform-types .audit/phase2/surface.mjs . > after.txt
//   node .audit/phase2/gate/surface-classes.mjs before.txt after.txt

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parse = (file) => {
	const out = new Map();
	let title = null;
	let lines = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.startsWith("== ")) {
			if (title !== null) out.set(title, lines.join("\n"));
			title = line.slice(3);
			lines = [];
		} else lines.push(line);
	}
	if (title !== null) out.set(title, lines.join("\n"));
	return out;
};

const [before, after] = [parse(process.argv[2]), parse(process.argv[3])];
const dir = mkdtempSync(join(tmpdir(), "surface-"));
const classes = new Map();
let same = 0;
for (const [title, text] of before) {
	if (!after.has(title)) continue;
	if (after.get(title) === text) {
		same++;
		continue;
	}
	writeFileSync(join(dir, "a"), text);
	writeFileSync(join(dir, "b"), after.get(title));
	let diff = "";
	try {
		execFileSync("diff", [join(dir, "a"), join(dir, "b")]);
	} catch (error) {
		diff = error.stdout.toString();
	}
	const key = diff
		.split("\n")
		.filter((line) => /^[<>]/.test(line))
		.map((line) => line.slice(0, 160))
		.join("\n");
	classes.set(key, [...(classes.get(key) ?? []), title]);
}
const gone = [...before.keys()].filter((title) => !after.has(title));
const added = [...after.keys()].filter((title) => !before.has(title));
console.log(`${before.size} sections before, ${after.size} after: ${same} the same, ${gone.length} gone, ${added.length} new`);
for (const [key, titles] of classes) {
	console.log(`\n### ${titles.length}: ${titles.slice(0, 4).join(" | ")}${titles.length > 4 ? " ..." : ""}`);
	console.log(key.split("\n").slice(0, 14).join("\n"));
}
