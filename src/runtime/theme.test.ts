import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { TERMINAL_COLORS, TERMINAL_STYLE } from "./theme.ts";

const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
const token = (name: string): number => {
	const value = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`).exec(tokens)?.[1];
	if (!value) throw new Error(`tokens.css has no --${name}`);
	return Number.parseInt(value, 16);
};

test("the cursor is --text, not rosewater, on a --base ground", () => {
	expect(TERMINAL_COLORS.cursor).toBe(token("text"));
	expect(TERMINAL_COLORS.cursor).not.toBe(token("hue-8"));
	expect(TERMINAL_COLORS.foreground).toBe(token("text"));
	expect(TERMINAL_COLORS.background).toBe(token("base"));
});

test("the palette is the handoff's sixteen colours in ANSI order: black, red, green, yellow, blue, magenta, cyan, white, then bright", () => {
	expect(TERMINAL_COLORS.palette.map((c) => `#${c.toString(16).padStart(6, "0")}`)).toEqual([
		"#45475a",
		"#f38ba8",
		"#a6e3a1",
		"#f9e2af",
		"#89b4fa",
		"#f5c2e7",
		"#94e2d5",
		"#bac2de",
		"#585b70",
		"#f38ba8",
		"#a6e3a1",
		"#f9e2af",
		"#89b4fa",
		"#f5c2e7",
		"#94e2d5",
		"#a6adc8",
	]);
});

test("the font is the --font token at 12.5px over 20px", () => {
	expect(TERMINAL_STYLE["--term-font-family"]).toMatch(/^var\(--font\b/);
	expect(TERMINAL_STYLE["--term-font-size"]).toBe("12.5px");
	expect(TERMINAL_STYLE["--term-row-height"]).toBe("20px");
	expect(tokens).toMatch(/--fs-term:\s*12\.5px/);
	expect(tokens).toMatch(/--lh-term:\s*20px/);
});
