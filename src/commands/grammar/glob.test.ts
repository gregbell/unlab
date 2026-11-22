import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { globMatch } from "./glob.ts";

describe("globMatch", () => {
	it("matches names by prefix, suffix and middle wildcards, and whole names exactly", () => {
		expect(globMatch("node*", "node1")).toBe(true);
		expect(globMatch("node*", "node12")).toBe(true);
		expect(globMatch("*", "node3")).toBe(true);
		expect(globMatch("n*1", "node1")).toBe(true);
		expect(globMatch("n*1", "node11")).toBe(true);
		expect(globMatch("n*1", "node12")).toBe(false);
		expect(globMatch("node1", "node1")).toBe(true);
		expect(globMatch("node1", "node12")).toBe(false);
		expect(globMatch("*2*", "node12")).toBe(true);
		expect(globMatch("x*", "node1")).toBe(false);
	});

	it("agrees with a regular expression built the slow way", () => {
		const slow = (glob: string, name: string) =>
			new RegExp(
				`^${glob
					.split("*")
					.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
					.join(".*")}$`,
			).test(name);
		const text = fc.stringMatching(/^[no*de1-3]{0,8}$/);
		fc.assert(fc.property(text, text, (glob, name) => globMatch(glob, name) === slow(glob, name)));
	});

	it("stays fast however many wildcards an agent sends", () => {
		const glob = `${"*".repeat(5000)}x`;
		const started = performance.now();
		for (let n = 1; n <= 8; n++) expect(globMatch(glob, `node${n}`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(100);
	});
});
