import { createKernel } from "unkernel/node";
import { expect, test, vi } from "vitest";
import { packageBackend } from "../../src/runtime/package-repositories.ts";

test("guest HTTP reaches only the configured HTTPS repository paths", async () => {
	const vm = await createKernel({ net: packageBackend() });
	const mirror = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("mirror response"));
	const get = (url: string) => vm.exec("wget", ["-T", "2", "-qO-", url]);
	try {
		for (const [guest, upstream] of [
			["http://dl-cdn.alpinelinux.org/alpine/index", "https://repo.c48.uk/alpine/index"],
			["http://deb.debian.org/debian/pool/pkg%2b1.deb", "https://mirror.unkernel.dev/deb/debian/pool/pkg%2b1.deb"],
			["http://deb.debian.org/debian-security/index", "https://mirror.unkernel.dev/deb/debian-security/index"],
		]) {
			expect(await get(guest)).toMatchObject({ exitCode: 0, stdout: "mirror response" });
			expect(mirror).toHaveBeenLastCalledWith(
				upstream,
				expect.objectContaining({ credentials: "omit", redirect: "error" }),
			);
		}
		mirror.mockClear();
		for (const url of [
			"http://example.org/alpine/index",
			"http://192.0.2.1/",
			"http://deb.debian.org/elsewhere",
			"http://deb.debian.org/debian/..%2felsewhere",
		])
			expect((await get(url)).exitCode).not.toBe(0);
		expect(mirror).not.toHaveBeenCalled();
		// Browsers expose only CORS-readable headers to fetch. An incomplete
		// 206 must be retried before the guest sees it as a package download.
		mirror.mockResolvedValueOnce(new Response("partial", { status: 206 }));
		const resumed = await vm.exec("wget", [
			"--header",
			"Range: bytes=1-",
			"-qO-",
			"http://dl-cdn.alpinelinux.org/alpine/pkg.apk",
		]);
		expect(resumed).toMatchObject({ exitCode: 0, stdout: "mirror response" });
		expect(mirror).toHaveBeenCalledTimes(2);
		expect(mirror.mock.calls[0][1]?.headers).toEqual({ Range: "bytes=1-" });
		expect(mirror.mock.calls[1][1]?.headers).toBeUndefined();
	} finally {
		mirror.mockRestore();
		vm.stop();
	}
});
