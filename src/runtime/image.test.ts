import { afterEach, describe, expect, test, vi } from "vitest";
import { imageSource } from "./image.ts";

const MANIFEST = {
	distros: [
		{ name: "alpine", file: "alpine.erofs", size: 4 },
		{ name: "debian", file: "debian.erofs", size: 4 },
	],
};

function serve(respond: (url: string) => Response) {
	const asked: string[] = [];
	vi.stubGlobal("crossOriginIsolated", false);
	vi.stubGlobal("fetch", async (url: string) => {
		asked.push(url);
		return respond(url);
	});
	return asked;
}

const fourBytes = () => new Response(Uint8Array.of(1, 2, 3, 4), { headers: { "content-length": "4" } });

afterEach(() => vi.unstubAllGlobals());

describe("imageSource", () => {
	test("fetches an image once, however many machines ask for it", async () => {
		const asked = serve(fourBytes);
		const image = imageSource(MANIFEST, "once/");
		const [a, b] = await Promise.all([image("alpine"), image("alpine")]);
		const c = await image("alpine");

		expect(asked).toEqual(["once/alpine.erofs"]);
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(new Uint8Array(a)).toEqual(Uint8Array.of(1, 2, 3, 4));
	});

	test("an image the manifest does not list fails with a sentence, and nothing is fetched", async () => {
		const asked = serve(fourBytes);
		await expect(imageSource(MANIFEST)("arch")).rejects.toThrow("No image called arch.");
		expect(asked).toEqual([]);
	});

	test("a failed fetch says what failed, and is tried again next time", async () => {
		let up = false;
		const asked = serve(() => (up ? fourBytes() : new Response("", { status: 404 })));
		const image = imageSource(MANIFEST, "retry/");
		await expect(image("debian")).rejects.toThrow("retry/debian.erofs: HTTP 404");

		up = true;
		expect(new Uint8Array(await image("debian"))).toEqual(Uint8Array.of(1, 2, 3, 4));
		expect(asked).toEqual(["retry/debian.erofs", "retry/debian.erofs"]);
	});

	test("a short image is an error, not a machine with a truncated disk", async () => {
		serve(() => new Response(Uint8Array.of(1, 2), { headers: { "content-length": "4" } }));
		await expect(imageSource(MANIFEST, "short/")("alpine")).rejects.toThrow(
			"short/alpine.erofs: got 2 bytes, expected 4",
		);
	});
});
