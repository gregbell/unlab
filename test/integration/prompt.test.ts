// Proves the guest half of exec: after setup, every shell in a real kernel
// prints OSC 133 marks that the shell tracker reads as prompts and exit codes.
import assert from "node:assert/strict";
import { createKernel, fetchDistro, type KernelInstance } from "unkernel/node";
import { test } from "vitest";
import { labMac, Subnet } from "../../src/net/index.ts";
import { execAsRoot, setupScript } from "../../src/runtime/guest.ts";
import { LabNic } from "../../src/runtime/nic.ts";
import { createShellTracker, type ShellEvent } from "../../src/runtime/shell-tracker.ts";

const SETUP = setupScript({ hostname: "node1", ip: "10.88.0.11", prefixBits: 24, hosts: [], dhcp: false });
const LOGIN_SHELL_PID = `for p in /proc/[0-9]*; do
  case "$(head -c1 "$p/cmdline" 2>/dev/null)" in -) ;; *) continue ;; esac
  [ "$(readlink "$p/fd/0" 2>/dev/null)" = /dev/hvc0 ] && echo "\${p#/proc/}"
done; true`;

/** A session's output run through the tracker, with a way to wait for what it reports. */
function tracked() {
	const tracker = createShellTracker();
	const events: ShellEvent[] = [];
	let text = "";
	let wake = () => {};

	async function until<T>(what: string, take: () => T | undefined): Promise<T> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			const found = take();
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error(`no ${what}; output so far: ${JSON.stringify(text.slice(-400))}`);
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 250);
			});
		}
	}

	return {
		tracker,
		text: () => text,
		feed(bytes: Uint8Array) {
			text += Buffer.from(bytes).toString("latin1");
			events.push(...tracker.scan(bytes));
			wake();
		},
		/** Resolves once the shell is at a prompt, forgetting what led up to it. */
		prompt: () =>
			until("prompt", () => {
				if (tracker.phase !== "prompt") return undefined;
				events.length = 0;
				return true;
			}),
		/** The exit code of the next command to finish. */
		finished: () =>
			until("finished command", () => {
				while (events.length) {
					const e = events.shift();
					if (e?.kind === "finished") return { exitCode: e.exitCode };
				}
				return undefined;
			}),
	};
}

test("setup gives every shell a prompt that reports exit codes, and running it again changes nothing", async () => {
	const distro = await fetchDistro("alpine");
	const nic = new LabNic({ mac: labMac(11), lab: new Subnet("10.88.0.0/24"), toSwitch: () => {} });
	let vm: KernelInstance | undefined;
	try {
		vm = await createKernel({ distro, net: nic, memoryMiB: 256, consoleSize: { cols: 100, rows: 30 } });
		const console_ = tracked();
		vm.onOutput((bytes) => console_.feed(bytes));

		const setup = await execAsRoot(vm, SETUP);
		assert.equal(setup.exitCode, 0, `setup failed: ${String(setup.stderr)}`);

		await console_.prompt();
		assert.equal(console_.tracker.phase, "prompt", "the respawned console shell marks its prompt");

		vm.write("false\n");
		console_.tracker.submitted();
		assert.equal((await console_.finished()).exitCode, 1, "false exits 1");
		vm.write("echo unlab-$((40+2))\n");
		console_.tracker.submitted();
		assert.equal((await console_.finished()).exitCode, 0, "echo exits 0");
		assert.match(console_.text(), /unlab-42/);
		assert.equal(console_.tracker.phase, "prompt");

		const pidBefore = String((await execAsRoot(vm, LOGIN_SHELL_PID)).stdout).trim();
		assert.match(pidBefore, /^\d+$/, "one login shell holds the console");
		const again = await execAsRoot(vm, SETUP);
		assert.equal(again.exitCode, 0, `second setup failed: ${String(again.stderr)}`);
		const pidAfter = String((await execAsRoot(vm, LOGIN_SHELL_PID)).stdout).trim();
		assert.equal(pidAfter, pidBefore, "a second setup does not hang up the console shell again");

		const pty = await vm.spawn(undefined, undefined, { pty: true, cols: 80, rows: 24, term: "xterm-256color" });
		const shell = tracked();
		void (async () => {
			const reader = pty.output.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				shell.feed(value);
			}
		})();
		await shell.prompt();
		assert.equal(shell.tracker.phase, "prompt", "a shell on its own pty gets the same prompt");
		await pty.write("sh -c 'exit 7'\n");
		shell.tracker.submitted();
		assert.equal((await shell.finished()).exitCode, 7);
		await pty.kill();
	} finally {
		vm?.stop({ code: 0, reason: "test over" });
	}
});
