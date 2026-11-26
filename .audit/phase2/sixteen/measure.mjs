// Boots sixteen machines of 256 MiB on two switches in the built app, has each ping the seven others in its
// subnet, and says how long it took and what the browser holds. It reads /proc, so it runs on Linux only.
//
//   vite build
//   node .audit/phase2/sixteen/measure.mjs dist [runs]
//   taskset -c 0-3 node .audit/phase2/sixteen/measure.mjs dist       on four CPUs, as GitHub's runner has
//
//   SPAWN="--cpus 1"     options for every spawn
//   SHOT=dir             saves a picture of the classic layout at ready

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { launch, serve, sleep } from "../worker-leak/browser.mjs";

const [dir, runs = "1"] = process.argv.slice(2);
const options = process.env.SPAWN ? ` ${process.env.SPAWN}` : "";
const MACHINES = 16;
const site = await serve(resolve(dir));

const hostMiB = (field) => Math.round(Number(new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) / 1024);
const sum = (list, field) => list.reduce((total, item) => total + item[field], 0);
function held(browser) {
	const all = browser.processes();
	const renderers = all.filter((p) => p.type === "renderer");
	return {
		pssMiB: sum(all, "pssMiB"),
		rssMiB: sum(all, "rssMiB"),
		swapMiB: sum(all, "swapMiB"),
		rendererPssMiB: sum(renderers, "pssMiB"),
		threads: sum(all, "threads"),
		workerThreads: browser.workerThreads().length,
		cpuSeconds: sum(all, "cpuSeconds"),
	};
}
const said = (what, h) =>
	`${what}: the browser holds ${h.pssMiB} MiB (PSS; ${h.rssMiB} RSS, ${h.swapMiB} swapped), its renderers ${h.rendererPssMiB} MiB, on ${h.threads} threads, ${h.workerThreads} of them workers`;

console.log(`${availableParallelism()} CPUs, ${hostMiB("MemTotal")} MiB of memory, ${hostMiB("MemAvailable")} MiB available; spawn options:${options || " none"}`);
for (let run = 1; run <= Number(runs); run++) {
	const browser = await launch();
	const tool = (name, input) =>
		browser
			.evaluate(`(async () => {
				const tool = (await document.modelContext.getTools()).find((tool) => tool.name === ${JSON.stringify(name)});
				try { return await document.modelContext.executeTool(tool, ${JSON.stringify(input)}); } catch (error) { return JSON.stringify({ threw: String(error) }); }
			})()`)
			.then((text) => JSON.parse(text));
	const list = async () => (await tool("machines_list", {})).data ?? [];
	async function until(what, test, ms = 300_000) {
		const deadline = Date.now() + ms;
		while (!(await test())) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify((await list()).map((m) => [m.name, m.state, m.reason]))}`);
			await sleep(200);
		}
	}
	try {
		await browser.open(`http://127.0.0.1:${site.port}/?layout=classic`);
		await until("the tools", () => browser.evaluate("document.modelContext?.getTools().then((tools) => tools.length > 5)").catch(() => false));
		const availableBefore = hostMiB("MemAvailable");
		console.log(`run ${run}`);
		const emptyLab = held(browser);
		console.log(said("  empty lab", emptyLab));

		const started = Date.now();
		await browser.typed("mkswitch lan");
		await browser.typed(`spawn 8 alpine${options}`);
		for (let n = 1; n <= 8; n++) await browser.typed(`spawn 1 alpine --net lan --addr 10.2.0.${10 + n}/24${options}`);
		const asked = Date.now() - started;
		await until("sixteen machines", async () => (await list()).length === MACHINES);
		await until("ready", async () => {
			const machines = await list();
			const failed = machines.filter((m) => m.state === "failed");
			if (failed.length > 0) throw new Error(`failed: ${failed.map((m) => `${m.name}: ${m.reason}`).join("; ")}`);
			return machines.every((m) => m.state === "ready");
		});
		const readyMs = Date.now() - started;
		console.log(`  16 ready ${(readyMs / 1000).toFixed(1)} s after the first command, which were typed in ${(asked / 1000).toFixed(1)} s`);
		const atReady = held(browser);
		console.log(said("  at ready", atReady));
		console.log(`  booting used ${((atReady.cpuSeconds - emptyLab.cpuSeconds) / (readyMs / 1000)).toFixed(1)} CPUs, ${(atReady.cpuSeconds - emptyLab.cpuSeconds).toFixed(0)} CPU seconds in all`);
		console.log(`  the host has ${availableBefore - hostMiB("MemAvailable")} MiB less available than before the first command`);
		if (process.env.SHOT) {
			mkdirSync(process.env.SHOT, { recursive: true });
			const { data } = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
			writeFileSync(`${process.env.SHOT}/classic-16.png`, Buffer.from(data, "base64"));
		}

		const machines = await list();
		const pinging = Date.now();
		const answers = await Promise.all(
			machines.map(async (machine) => {
				const peers = machines.filter((other) => other !== machine && other.nics[0].switch === machine.nics[0].switch);
				const command = `for peer in ${peers.map((peer) => peer.address).join(" ")}; do ping -c 1 -W 5 $peer >/dev/null || echo no answer from $peer; done; echo pinged ${peers.length}`;
				const reply = await tool("shell_exec", { targets: machine.name, command });
				return `${machine.name}: ${reply.data?.ran?.[0]?.output ?? JSON.stringify(reply)}`;
			}),
		);
		const wrong = answers.filter((answer) => !/: pinged 7$/.test(answer));
		console.log(`  ${answers.length - wrong.length} of 16 machines had an answer from each of the 7 others on their switch, in ${((Date.now() - pinging) / 1000).toFixed(1)} s${wrong.length ? `; not: ${wrong.join(" | ")}` : ""}`);

		const idleFrom = held(browser);
		await sleep(20_000);
		const idle = held(browser);
		console.log(said("  after the pings and 20 s idle", idle));
		console.log(`  idle, the browser used ${((idle.cpuSeconds - idleFrom.cpuSeconds) / 20).toFixed(2)} of a CPU`);

		const stopping = Date.now();
		const off = await tool("machines_poweroff", { names: "all" });
		const offMs = Date.now() - stopping;
		const forced = (off.data ?? []).filter((m) => m.reason).length;
		if (!(await list()).every((m) => m.state === "off")) throw new Error(`not all off: ${JSON.stringify(off)}`);
		while (browser.workerThreads().length > 0 && Date.now() - stopping < 60_000) await sleep(100);
		console.log(`  all off in ${(offMs / 1000).toFixed(1)} s${forced ? `, ${forced} of them stopped by force` : ""}, and no worker thread was left ${((Date.now() - stopping) / 1000).toFixed(1)} s after the command`);
		await sleep(2000);
		console.log(said("  off", held(browser)));
	} catch (error) {
		console.log(`  ${error.message}`);
		console.log(said("  then", held(browser)));
	} finally {
		await browser.close();
	}
}
site.close();
process.exit(0);
