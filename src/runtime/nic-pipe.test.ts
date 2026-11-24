import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NIC_HELPER, SOURCE_SHA256 } from "./nic-helper.ts";
import { FRAME_MAX, FrameCutter, packFrames } from "./nic-pipe.ts";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe("frames on a pipe", () => {
	it("puts a big-endian length before each frame, an empty one included", () => {
		expect([...packFrames([bytes(1, 2, 3), bytes(), new Uint8Array(258)])].slice(0, 9)).toEqual([
			0, 3, 1, 2, 3, 0, 0, 1, 2,
		]);
	});

	it("holds a frame of the longest length and refuses a longer one", () => {
		const longest = new Uint8Array(FRAME_MAX).fill(7);
		expect(new FrameCutter().push(packFrames([longest]))).toEqual([longest]);
		expect(() => packFrames([new Uint8Array(FRAME_MAX + 1)])).toThrow("a frame of 65536 bytes");
	});

	it("gives back the same frames however the pipe cuts them", () => {
		fc.assert(
			fc.property(
				fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 12 }),
				fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1 }),
				(frames, sizes) => {
					const piped = packFrames(frames);
					const cutter = new FrameCutter();
					const got: Uint8Array[] = [];
					for (let at = 0, i = 0; at < piped.length; i++) {
						const size = sizes[i % sizes.length];
						// The pipe's own buffer, overwritten after each read.
						const chunk = piped.slice(at, at + size);
						got.push(...cutter.push(chunk));
						chunk.fill(0xee);
						at += size;
					}
					expect(got).toEqual(frames);
				},
			),
		);
	});
});

describe("the embedded helper", () => {
	it("is built from the source that is checked in", () => {
		const source = readFileSync(new URL("./unlab-nic.c", import.meta.url));
		expect(SOURCE_SHA256, "unlab-nic.c has changed; run npm run nic-helper").toBe(
			createHash("sha256").update(source).digest("hex"),
		);
	});

	it("is an aarch64 Linux executable", () => {
		expect(String.fromCharCode(...NIC_HELPER.subarray(1, 4))).toBe("ELF");
		expect(NIC_HELPER[18] | (NIC_HELPER[19] << 8)).toBe(183);
	});
});
