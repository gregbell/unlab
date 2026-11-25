import { createKernel, fetchRoutes } from "unkernel/node";
import { expect, test } from "vitest";
import { execAsRoot } from "../../src/runtime/guest.ts";
import { alpinePackageSetup } from "../../src/runtime/package-repositories.ts";
import { imagePath } from "../support/images.ts";

test("apk requests both main and community indexes for the guest's release", async () => {
	const indexes: string[] = [];
	const net = fetchRoutes(undefined, {
		"dl-cdn.alpinelinux.org": (request) => {
			indexes.push(new URL(request.url).pathname);
			return new Response(null, { status: 404 });
		},
	});
	const vm = await createKernel({ distro: imagePath("alpine"), net });
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
		// As a machine has them that an earlier lab set up.
		const base = `http://dl-cdn.alpinelinux.org/alpine/v${version}`;
		const both = `${base}/main\n${base}/community\n`;
		expect((await vm.exec("cat", ["/etc/apk/repositories"])).stdout).toBe(both);
		expect((await execAsRoot(vm, 'echo "$1" > /etc/apk/repositories', [`${base} main community`])).exitCode).toBe(0);
		expect((await execAsRoot(vm, alpinePackageSetup)).exitCode).toBe(0);
		expect((await vm.exec("cat", ["/etc/apk/repositories"])).stdout).toBe(both);
		// A guest can edit its repositories using an editor that saves by rename.
		const main = `http://dl-cdn.alpinelinux.org/alpine/v${version}/main`;
		const edit = await execAsRoot(vm, 'echo "$1" > /etc/apk/new && mv /etc/apk/new /etc/apk/repositories', [main]);
		expect(edit.exitCode, String(edit.stderr)).toBe(0);
		expect((await execAsRoot(vm, alpinePackageSetup)).exitCode).toBe(0);
		expect((await vm.exec("cat", ["/etc/apk/repositories"])).stdout).toBe(`${main}\n`);
	} finally {
		vm.stop();
	}
});
