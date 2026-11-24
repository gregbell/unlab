import { createKernel, fetchDistro, fetchRoutes } from "unkernel/node";
import { expect, test } from "vitest";
import { execAsRoot } from "../../src/runtime/guest.ts";
import { alpinePackageSetup } from "../../src/runtime/package-prototype.ts";

test("apk requests both main and community indexes for the guest's release", async () => {
	const indexes: string[] = [];
	const net = fetchRoutes(undefined, {
		"dl-cdn.alpinelinux.org": (request) => {
			indexes.push(new URL(request.url).pathname);
			return new Response(null, { status: 404 });
		},
	});
	const vm = await createKernel({ distro: await fetchDistro("alpine"), net });
	try {
		const version = String((await vm.exec("cat", ["/etc/alpine-release"])).stdout)
			.trim()
			.split(".")
			.slice(0, 2)
			.join(".");
		const arch = String((await vm.exec("apk", ["--print-arch"])).stdout).trim();
		const setup = await execAsRoot(vm, alpinePackageSetup);
		expect(setup.exitCode, String(setup.stderr)).toBe(0);
		await execAsRoot(vm, "apk update");
		expect(indexes.sort()).toEqual(
			["community", "main"].map((repo) => `/alpine/v${version}/${repo}/${arch}/APKINDEX.tar.gz`),
		);
	} finally {
		vm.stop();
	}
});
