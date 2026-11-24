// The whole runtime in a real browser: two real kernels in real workers on the
// switch, driven only by effects, observed only through runtime events, the
// capture log and the screens. Needs the mirrored image (npm run distros).
import "@wterm/dom/css";
import { afterAll, describe, expect, test } from "vitest";
import { createCaptureLog } from "../capture/index.ts";
import type { BootConfig, Effect, HostEntry, RuntimeEvent } from "../model/index.ts";
import { labMac } from "../net/index.ts";
import type { DistroManifest } from "./image.ts";
import { createRuntime } from "./runtime.ts";

const manifest: DistroManifest | null = await fetch("/distros/distros.json")
	.then((r) => (r.ok ? r.json() : null))
	.catch(() => null);
const alpine = manifest?.distros.find((d) => d.name === "alpine");
const haveImage = alpine ? (await fetch(`/distros/${alpine.file}`, { method: "HEAD" })).ok : false;

const HOSTS: HostEntry[] = [
	{ ip: "10.88.0.11", name: "node1" },
	{ ip: "10.88.0.12", name: "node2" },
];
const config = (n: number): BootConfig => ({
	identity: { n, name: `node${n}`, ip: `10.88.0.${10 + n}`, mac: labMac(10 + n) },
	spec: { image: "alpine", memMiB: 256, net: "switch0" },
	hosts: HOSTS,
});

function lab() {
	const t0 = performance.now();
	const now = () => performance.now() - t0;
	const events: RuntimeEvent[] = [];
	const waiting = new Set<() => void>();
	const capture = createCaptureLog({ now, schedule: (fn) => requestAnimationFrame(fn) });
	const engine = createRuntime({
		store: {
			dispatchRuntime(e) {
				events.push(e);
				for (const check of [...waiting]) check();
			},
		},
		capture,
		manifest: manifest ?? { distros: [] },
		announce: () => {},
		now,
	});
	const until = (what: string, found: (e: RuntimeEvent) => boolean, ms = 90_000) =>
		new Promise<RuntimeEvent>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms);
			const check = () => {
				const e = events.find(found);
				if (!e) return;
				clearTimeout(timer);
				waiting.delete(check);
				resolve(e);
			};
			waiting.add(check);
			check();
		});
	const run = (...effects: Effect[]) => {
		for (const e of effects) engine.run(e);
	};
	return { engine, capture, events, until, run };
}

const hosts: HTMLElement[] = [];
function pane(): HTMLElement {
	const el = document.createElement("div");
	el.style.cssText = "width:720px;height:320px;";
	document.body.append(el);
	hosts.push(el);
	return el;
}

afterAll(() => {
	for (const el of hosts) el.remove();
});

describe.skipIf(!haveImage)("real kernels", () => {
	test("boot, exec with exit codes and marks, capture, a cut cable, a shell, and teardown", async () => {
		const { engine, capture, events, until, run } = lab();
		const never = new AbortController().signal;

		run(
			{ type: "screen/create", session: "node1:console" },
			{ type: "screen/create", session: "node2:console" },
			{ type: "port/attach", port: 1, machine: "node1" },
			{ type: "port/attach", port: 2, machine: "node2" },
			{ type: "vm/boot", machine: "node1", attempt: 1, config: config(1) },
			{ type: "vm/boot", machine: "node2", attempt: 1, config: config(2) },
			{ type: "hosts/publish", hosts: HOSTS },
		);
		const console1 = engine.screens.get("node1:console");
		if (!console1) throw new Error("no screen for node1:console");
		const el = pane();
		await console1.mount(el);

		await until("node1 ready", (e) => e.type === "vm/ready" && e.machine === "node1");
		await until("node2 ready", (e) => e.type === "vm/ready" && e.machine === "node2");
		// What the model does at ready: a reserved port goes live.
		run(
			{ type: "link/set", port: 1, machine: "node1", up: true, cause: "runtime" },
			{ type: "link/set", port: 2, machine: "node2", up: true, cause: "runtime" },
		);

		const firstPrompt = events.findIndex((e) => e.type === "session/shell" && e.session === "node1:console");
		const ready = events.findIndex((e) => e.type === "vm/ready" && e.machine === "node1");
		expect(firstPrompt).toBeGreaterThanOrEqual(0);
		expect(firstPrompt).toBeLessThan(ready);
		expect(console1.shell).toBe("prompt");
		expect(console1.readText()).toContain("Welcome to Alpine Linux");
		expect(console1.lastLines(1)).toBe("~ ⇒");

		const ping = await engine.exec.inject("node1:console", "ping -c 2 -W 2 node2", "bar", never);
		expect(ping.exitCode).toBe(0);
		expect(ping.output).toMatch(/PING node2 \(10\.88\.0\.12\)/);
		expect(ping.output).toMatch(/2 packets transmitted, 2 (packets )?received/);
		expect(ping.output).not.toContain("ping -c 2");
		expect(ping.lastLine).toMatch(/^round-trip/);
		expect(ping.ms).toBeGreaterThan(0);
		expect(capture.tail(200)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "frame",
					proto: "ICMP",
					from: { kind: "machine", name: "node1" },
					to: { kind: "machine", name: "node2" },
				}),
			]),
		);
		expect(engine.reads.macTable().map((e) => [e.mac, e.port])).toEqual(
			expect.arrayContaining([
				[labMac(11), 1],
				[labMac(12), 2],
			]),
		);

		const failed = await engine.exec.inject("node1:console", "false", "agent", never);
		expect(failed).toMatchObject({ exitCode: 1, output: "", lastLine: "" });
		expect(events).toContainEqual({ type: "session/marked", session: "node1:console", source: "agent" });

		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(console1.marks().map((m) => m.source)).toEqual(["bar", "agent"]);
		expect(el.textContent).toContain("2 packets transmitted");

		run({ type: "link/set", port: 2, machine: "node2", up: false, cause: "bar" });
		const cut = await engine.exec.inject("node1:console", "ping -c 1 -W 1 node2", "bar", never);
		expect(cut.exitCode).toBe(1);
		expect(capture.tail(200)).toContainEqual(
			expect.objectContaining({ kind: "link", port: 2, up: false, cause: "Cable to node2 cut by you." }),
		);

		run({ type: "screen/create", session: "node1:sh1" }, { type: "pty/open", session: "node1:sh1" });
		const shell = engine.screens.get("node1:sh1");
		const shellPane = pane();
		await shell?.mount(shellPane);
		await until("node1:sh1 opened", (e) => e.type === "session/opened" && e.session === "node1:sh1");
		await until("node1:sh1 prompt", (e) => e.type === "session/shell" && e.session === "node1:sh1");
		const sum = await engine.exec.inject("node1:sh1", "echo unlab-$((40+2))", "bar", never);
		expect(sum).toMatchObject({ exitCode: 0, output: "unlab-42", lastLine: "unlab-42" });

		const wide = `echo ${"w".repeat(150)}; echo done`;
		const wrapped = await engine.exec.inject("node1:console", wide, "agent", never);
		expect(wrapped).toMatchObject({ exitCode: 0, output: `${"w".repeat(150)}\ndone` });

		// A resize keeps what the terminal holds: at a prompt, and while a command runs.
		const settled = () => new Promise((resolve) => setTimeout(resolve, 500));
		const prompts = () =>
			console1
				.readText()
				.split("\n")
				.filter((line) => line.startsWith("~ ⇒")).length;
		const before = prompts();
		for (const size of ["width:600px;height:320px;", "width:720px;height:220px;", "width:720px;height:320px;"]) {
			el.style.cssText = size;
			await settled();
			expect(console1.lastLines(1)).toBe("~ ⇒");
			expect(prompts()).toBe(before);
		}
		const slow = engine.exec.inject("node1:console", "echo early; sleep 2; echo late", "agent", never);
		await new Promise((resolve) => setTimeout(resolve, 500));
		el.style.cssText = "width:600px;height:220px;";
		expect(await slow).toMatchObject({ exitCode: 0, output: "early\nlate" });

		const busy = engine.exec.inject("node1:sh1", "sleep 30", "bar", never);
		await expect(engine.exec.inject("node1:sh1", "ls", "bar", never)).rejects.toThrow(
			"node1:sh1 is running a program.",
		);

		const stopAsked = performance.now();
		run({ type: "vm/stop", machine: "node1", attempt: 1 }, { type: "vm/stop", machine: "node2", attempt: 1 });
		await expect(busy).rejects.toThrow("node1:sh1 closed before the command returned.");
		await until("node1 stopped", (e) => e.type === "vm/stopped" && e.machine === "node1", 5_000);
		await until("node2 stopped", (e) => e.type === "vm/stopped" && e.machine === "node2", 5_000);
		expect(performance.now() - stopAsked).toBeGreaterThanOrEqual(240);

		engine.dispose();
		expect([el.childElementCount, shellPane.childElementCount]).toEqual([0, 0]);
	});
});
