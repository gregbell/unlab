import { createKernel, directBackend, fetchDistro } from "unkernel/node";
import { expect, test } from "vitest";
import { execAsRoot } from "../../src/runtime/guest.ts";

test("strace runs a command to completion and prints its system calls", async () => {
	const vm = await createKernel({ distro: await fetchDistro("alpine"), net: directBackend() });
	try {
		const installed = await execAsRoot(vm, "/usr/lib/kw/net wait; apk add --quiet strace");
		expect(installed.exitCode, installed.stderr).toBe(0);
		const traced = await execAsRoot(vm, "timeout 20 strace cat /etc/hostname");
		expect(traced.exitCode, traced.stderr).toBe(0);
		expect(traced.stdout.trim()).toBe("localhost");
		expect(traced.stderr).toMatch(/openat\(AT_FDCWD, "\/etc\/hostname", .*\) = \d+/);
		expect(traced.stderr).toContain("+++ exited with 0 +++");
	} finally {
		vm.stop();
	}
});
