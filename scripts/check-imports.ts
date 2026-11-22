import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

export type Layer = "net" | "model" | "capture" | "commands" | "agent" | "runtime" | "ui";

interface Rule {
	/** Layers whose index.ts this layer may import values from. */
	readonly values: readonly Layer[];
	/** Layers this layer may import only with `import type`. */
	readonly types: readonly Layer[];
}

export const LAYERS: Readonly<Record<Layer, Rule>> = {
	net: { values: [], types: [] },
	model: { values: ["net"], types: [] },
	capture: { values: ["net", "model"], types: [] },
	commands: { values: ["net", "model"], types: [] },
	agent: { values: ["model", "commands"], types: ["capture"] },
	runtime: { values: ["net", "model", "capture"], types: ["commands"] },
	ui: { values: ["net", "model", "commands"], types: ["capture"] },
};

/** Deep imports allowed across layers, each with the reason it exists. */
const NAMED_EXCEPTIONS: ReadonlyArray<{ from: string; to: string }> = [
	// Minting an Approval is restricted to the two surfaces that ask a person.
	{ from: "src/ui/command-bar/", to: "src/commands/approval.ts" },
	{ from: "src/agent/", to: "src/commands/approval.ts" },
];

/** The prototype UI, exempt until the rewrite deletes it. Remove entries, never add them. */
const LEGACY = new Set([
	"src/ui/wire.ts",
	"src/ui/sidebar.ts",
	"src/ui/topology.ts",
	"src/ui/terminal.ts",
	"src/ui/workspace.ts",
	"src/ui/icons.ts",
]);

export interface SourceFile {
	/** Repo-relative, forward slashes: `src/ui/rail/row.ts`. */
	readonly path: string;
	readonly text: string;
}

export interface Violation {
	readonly file: string;
	readonly specifier: string;
	readonly reason: string;
}

const IMPORT = /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function layerOf(path: string): Layer | null {
	const match = /^src\/([^/]+)\//.exec(path);
	const dir = match?.[1];
	return dir !== undefined && dir in LAYERS ? (dir as Layer) : null;
}

export function checkImports(files: readonly SourceFile[]): Violation[] {
	const out: Violation[] = [];
	for (const file of files) {
		const from = layerOf(file.path);
		if (!from || LEGACY.has(file.path)) continue;
		const isTest = file.path.endsWith(".test.ts");
		for (const m of file.text.matchAll(IMPORT)) {
			const typeOnly = m[2] !== undefined;
			const specifier = m[3] ?? "";
			if (!specifier.startsWith(".")) continue;
			const target = normalize(join(dirname(file.path), specifier)).replaceAll("\\", "/");
			const to = layerOf(target);
			if (!to || to === from) continue;
			if (NAMED_EXCEPTIONS.some((e) => file.path.startsWith(e.from) && target === e.to)) continue;
			const rule = LAYERS[from];
			const allowed = rule.values.includes(to) || (typeOnly && rule.types.includes(to)) || isTest;
			if (!allowed) {
				out.push({ file: file.path, specifier, reason: `${from} may not import ${to}` });
				continue;
			}
			if (target !== `src/${to}/index.ts`) {
				out.push({ file: file.path, specifier, reason: `import ${to} through src/${to}/index.ts` });
			}
		}
	}
	return out;
}

function listTs(root: string, dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
		const path = `${dir}/${e.name}`;
		if (e.isDirectory()) return listTs(root, path);
		return e.name.endsWith(".ts") ? [path] : [];
	});
}

if (import.meta.main) {
	const root = join(dirname(new URL(import.meta.url).pathname), "..");
	const files = listTs(root, "src").map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
	const violations = checkImports(files);
	for (const v of violations) console.error(`${v.file}: "${v.specifier}" (${v.reason})`);
	if (violations.length) {
		console.error(`${violations.length} import boundary violation(s). See .audit/arch/synthesis.md.`);
		process.exit(1);
	}
	console.log(`import boundaries hold across ${files.length} files (${relative(process.cwd(), root) || "."})`);
}
