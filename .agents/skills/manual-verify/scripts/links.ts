// Prints every relative link in the Manual whose file or #anchor does not exist, one per line.
// Also checks links into the Manual from README.md and cli/README.md. Prints nothing, and exits 0, when all resolve.
// Run from the repo root: node .agents/skills/manual-verify/scripts/links.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const MANUAL = "docs/manual";

/** GitHub's heading anchor: lowercase, punctuation dropped (hyphens and underscores kept), spaces to hyphens. */
function slug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

function anchors(file: string): Set<string> {
	const seen = new Map<string, number>();
	const out = new Set<string>();
	let fenced = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		const heading = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (!heading) continue;
		const base = slug(heading[1].replace(/`/g, ""));
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		out.add(n === 0 ? base : `${base}-${n}`);
	}
	return out;
}

function links(file: string): string[] {
	const text = readFileSync(file, "utf8")
		.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, "")
		.replace(/`[^`\n]*`/g, "");
	return [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

function report(line: string): void {
	console.log(line);
	process.exitCode = 1;
}

const files = [
	...readdirSync(MANUAL)
		.filter((f) => f.endsWith(".md"))
		.map((f) => join(MANUAL, f)),
	"README.md",
	"cli/README.md",
];

for (const file of files) {
	for (const link of links(file)) {
		if (/^[a-z]+:/i.test(link)) continue;
		const [path, anchor] = link.split("#");
		const target = path === "" ? file : normalize(join(dirname(file), decodeURI(path)));
		const intoManual = target.startsWith(`${MANUAL}/`) || target === MANUAL;
		if (!file.startsWith(`${MANUAL}/`) && !intoManual) continue;
		if (!existsSync(target)) report(`${file}: ${link} (no file ${target})`);
		else if (anchor && target.endsWith(".md") && !anchors(target).has(anchor))
			report(`${file}: ${link} (no heading #${anchor} in ${target})`);
	}
}
