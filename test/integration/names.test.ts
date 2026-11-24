// A name someone chose, on real kernels: what the guest calls itself, what its
// prompt shows, and what the other machines reach by it.
import { afterEach, describe, expect, test, vi } from "vitest";
import { LOOPBACK_NAMES, MAX_NAME } from "../../src/model/identity.ts";
import { bootLab, type MachineSetup, type TestLab, type TestMachine } from "./lab.ts";

const DISTROS = ["alpine", "debian"] as const;

const running: TestLab[] = [];
async function lab(...setups: MachineSetup[]): Promise<TestLab> {
	const booted = await bootLab(setups);
	running.push(booted);
	return booted;
}
afterEach(async () => {
	await Promise.all(running.splice(0).map((l) => l.stop()));
});

/** The console's last line once it shows a prompt. */
const prompt = (machine: TestMachine) =>
	vi.waitFor(
		() => {
			const last =
				machine
					.console()
					.split(/\r?\n|\r/)
					.at(-1)
					?.trim() ?? "";
			expect(last).toMatch(/⇒$/);
			return last;
		},
		{ timeout: 30_000, interval: 100 },
	);

describe.each(DISTROS)("a name on %s", (distro) => {
	test("is the hostname and in the prompt, where node and a number is the hostname alone", async () => {
		const long = `w${"-".repeat(MAX_NAME - 2)}1`;
		const l = await lab(
			{ n: 1, name: "web-1", ports: [1], distro },
			{ n: 2, name: long, ports: [2], distro },
			{ n: 3, ports: [3], distro },
		);
		const names = ["web-1", long, "node3"];
		for (const [i, name] of names.entries()) {
			expect((await l.machines[i].run("hostname")).trim()).toBe(name);
			expect((await l.machines[i].run("cat /proc/sys/kernel/hostname")).trim()).toBe(name);
		}
		expect(await Promise.all(l.machines.map(prompt))).toEqual(["web-1 ~ ⇒", `${long} ~ ⇒`, "~ ⇒"]);
	});

	test("is reached by it from a machine of either image, and reaches itself", async () => {
		const l = await lab(
			{ n: 1, name: "web-1", ports: [1], addr: ["10.1.0.1/24"], distro },
			{ n: 2, name: "db", ports: [2], addr: ["10.1.0.2/24"], distro: "alpine" },
			{ n: 3, name: "node", ports: [3], addr: ["10.1.0.3/24"], distro: "debian" },
			{ n: 4, name: "shy", ports: [4], addr: [null], distro },
		);
		const [web, db, node, shy] = l.machines;
		for (const from of [web, db, node]) {
			for (const [name, address] of [
				["web-1", "10.1.0.1"],
				["db", "10.1.0.2"],
				["node", "10.1.0.3"],
			]) {
				const ping = await from.run(`ping -c 1 -W 2 ${name}`);
				expect(ping, `${from.name} to ${name}`).toContain(address);
				expect(await from.run(`getent hosts ${name}`)).toMatch(new RegExp(`^${address}\\s+${name}\\b`));
			}
			expect(await from.run("cat /etc/hosts")).not.toContain("shy");
		}
		expect(await shy.run("su user -c 'sudo -n true' 2>&1")).toBe("");
	});

	test("is none of those the image has already given the guest itself", async () => {
		const l = await lab({ n: 1, name: "web-1", ports: [1], addr: [null], distro });
		const hosts = await l.machines[0].run("sed '/^# unlab: begin$/,/^# unlab: end$/d' /etc/hosts");
		const own = hosts
			.split("\n")
			.map((line) => line.replace(/#.*/, "").trim())
			.flatMap((line) => line.split(/\s+/).slice(1))
			.filter((name) => !name.includes("."));
		expect(own.length).toBeGreaterThan(0);
		for (const name of own) expect(LOOPBACK_NAMES).toContain(name);
	});
});
