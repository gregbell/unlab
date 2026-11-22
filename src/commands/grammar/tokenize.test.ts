import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenize.ts";

describe("tokenize", () => {
	it("splits on spaces and keeps each token's offsets for the carets", () => {
		const line = "link  dwon node3";
		const { tokens, passthrough } = tokenize(line);
		expect(tokens).toEqual([
			{ text: "link", start: 0, end: 4 },
			{ text: "dwon", start: 6, end: 10 },
			{ text: "node3", start: 11, end: 16 },
		]);
		expect(tokens.map((t) => line.slice(t.start, t.end))).toEqual(["link", "dwon", "node3"]);
		expect(passthrough).toBeNull();
	});

	it("gives no tokens for a blank line", () => {
		expect(tokenize("   ").tokens).toEqual([]);
	});

	it("ends parsing at a bare -- and passes the rest through untouched", () => {
		const { tokens, passthrough } = tokenize("exec all -- ping  -c1 node3 -- --mem 'a  b'");
		expect(tokens.map((t) => t.text)).toEqual(["exec", "all", "--"]);
		expect(tokens[2]).toEqual({ text: "--", start: 9, end: 11 });
		expect(passthrough).toBe("ping  -c1 node3 -- --mem 'a  b'");
	});

	it("gives an empty passthrough for a line that ends at --", () => {
		expect(tokenize("exec all --").passthrough).toBe("");
		expect(tokenize("exec all --  ").passthrough).toBe("");
	});

	it("treats -- inside a token as an ordinary token", () => {
		const { tokens, passthrough } = tokenize("capture a--b --mem");
		expect(tokens.map((t) => t.text)).toEqual(["capture", "a--b", "--mem"]);
		expect(passthrough).toBeNull();
	});
});
