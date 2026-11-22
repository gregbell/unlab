import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function token(name: string): string {
	const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
	if (!match?.[1]) throw new Error(`tokens.css has no hex colour --${name}`);
	return match[1];
}

/** WCAG 2.2 relative luminance of an sRGB hex colour. */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((at) => {
		const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(foreground: string, background: string): number {
	const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("the handoff's contrast claims, measured from tokens.css", () => {
	const base = token("base");

	it.each([
		["text", 11.3],
		["text-2", 7.4],
		["text-3", 5.8],
	])("--%s measures %f:1 on --base", (name, ratio) => {
		expect(Math.abs(contrast(token(name), base) - ratio)).toBeLessThanOrEqual(0.1);
	});

	it.each(["ok", "down", "warn", "agent", "link-hover", ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `hue-${n}`)])(
		"--%s is 7:1 or better on --base",
		(name) => {
			expect(contrast(token(name), base)).toBeGreaterThanOrEqual(7);
		},
	);

	it.each(["mantle", "crust"])("--%s is darker than --base, so every ratio only rises there", (name) => {
		expect(luminance(token(name))).toBeLessThan(luminance(base));
	});
});
