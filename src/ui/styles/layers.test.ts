import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ui = new URL("..", import.meta.url).pathname;
const ORDER = "@layer tokens, base, components;";

function sheets(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "styles" ? [] : sheets(path);
		return entry.name.endsWith(".css") ? [path] : [];
	});
}

describe("element stylesheets", () => {
	const paths = sheets(ui);

	it("exist", () => {
		expect(paths.length).toBeGreaterThan(0);
	});

	// An element module can load its sheet before the app's, and the first
	// `@layer` rule a page sees fixes the order. Without this, base would beat components.
	it.each(paths.map((path) => [relative(ui, path), path]))("%s states the layer order first", (_, path) => {
		const rules = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		expect(rules.trimStart().startsWith(ORDER)).toBe(true);
	});

	it.each(paths.map((path) => [relative(ui, path), path]))("%s puts its rules in the components layer", (_, path) => {
		const rules = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		expect(rules.trimStart().slice(ORDER.length).trimStart().startsWith("@layer components {")).toBe(true);
	});
});
