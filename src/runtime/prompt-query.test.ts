import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPromptQueryFilter } from "./prompt-query.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function through(chunks: readonly string[]): string {
	const filter = createPromptQueryFilter();
	return chunks.map((c) => dec(filter(enc(c)))).join("");
}

const PROMPT = "\x1b]133;D;0\x07\x1b]133;A\x07\x1b[36m~ \x1b[35m=>\x1b[0m \x1b]133;B\x07";

describe("the prompt's cursor query", () => {
	it("is removed when it directly follows the prompt's end mark", () => {
		expect(through([`${PROMPT}\x1b[6n`])).toBe(PROMPT);
	});

	it("is removed after a mark ended with ST as well as BEL", () => {
		expect(through(["\x1b]133;B\x1b\\\x1b[6n"])).toBe("\x1b]133;B\x1b\\");
	});

	it("is removed wherever the stream splits it, and nothing else changes", () => {
		const stream = `boot log\r\n${PROMPT}\x1b[6necho hi\r\nhi\r\n${PROMPT}\x1b[6n`;
		const expected = `boot log\r\n${PROMPT}echo hi\r\nhi\r\n${PROMPT}`;
		fc.assert(
			fc.property(fc.uniqueArray(fc.integer({ min: 1, max: stream.length - 1 }), { maxLength: 6 }), (cuts) => {
				const at = [0, ...cuts.sort((a, b) => a - b), stream.length];
				const chunks = at.slice(1).map((end, i) => stream.slice(at[i], end));
				expect(through(chunks)).toBe(expected);
			}),
		);
	});

	it("still reaches the terminal when a program asks, away from a prompt", () => {
		expect(through(["vi: \x1b[6n"])).toBe("vi: \x1b[6n");
		expect(through([`${PROMPT}x\x1b[6n`])).toBe(`${PROMPT}x\x1b[6n`);
	});

	it("lets through a sequence after the mark that only starts like the query", () => {
		expect(through([`${PROMPT}\x1b[6`, "1m"])).toBe(`${PROMPT}\x1b[61m`);
		expect(through([`${PROMPT}\x1b[0m`])).toBe(`${PROMPT}\x1b[0m`);
	});

	it("hands back plain output untouched", () => {
		const filter = createPromptQueryFilter();
		const plain = enc("64 bytes from 10.88.0.12\r\n");
		expect(filter(plain)).toBe(plain);
	});
});
