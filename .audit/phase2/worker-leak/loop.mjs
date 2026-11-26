// Powers machines off and on in the built app, and counts the worker threads that outlive a power-off.
//
//   vite build
//   node .audit/phase2/worker-leak/loop.mjs dist [rounds] [machines] [guest|command]
//
//   SPAWN="spawn 4 alpine"   the line that makes the machines (the default has no network)
//   BUSY_MS=50               each worker stays busy this long after it says its disks are saved
//
// `guest` types poweroff in each guest and `command` runs the lab's own. Each line it prints: the threads
// left once the lab says off, and how long they took to go. Threads that are left are printed by their stacks.

import { resolve } from "node:path";
import { launch, serve, sleep, stackPrint } from "./browser.mjs";

const [dir, rounds = "20", count = "4", how = "guest"] = process.argv.slice(2);
const machines = Number(count);
const line = process.env.SPAWN ?? `spawn ${machines} alpine --no-net`;
const busy = Number(process.env.BUSY_MS ?? 0);

const BUSY = `{
	const post = self.postMessage.bind(self);
	self.postMessage = (message, transfer) => {
		post(message, transfer);
		if (message?.type !== "released") return;
		const until = performance.now() + ${busy};
		while (performance.now() < until);
	};
}`;
const site = await serve(resolve(dir), (path, body) => (busy > 0 && /\/vm-worker-/.test(path) ? `${BUSY}\n${body}` : body));
const browser = await launch();

const tool = (name, input) =>
	browser
		.evaluate(`(async () => {
			const tool = (await document.modelContext.getTools()).find((tool) => tool.name === ${JSON.stringify(name)});
			try { return await document.modelContext.executeTool(tool, ${JSON.stringify(input)}); } catch (error) { return JSON.stringify({ threw: String(error) }); }
		})()`)
		.then((text) => JSON.parse(text));
async function until(what, test, ms = 120_000) {
	const deadline = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}
const all = async (state) => {
	const list = (await tool("machines_list", {})).data ?? [];
	return list.length === machines && list.every((machine) => machine.state === state);
};

let left = 0;
let leaks = 0;
const took = [];
try {
	await browser.open(`http://127.0.0.1:${site.port}/?layout=classic`);
	await until("the tools", () => browser.evaluate("document.modelContext?.getTools().then((tools) => tools.length > 5)").catch(() => false));
	await browser.typed(line);
	await until("ready", () => all("ready"));
	const each = browser.workerThreads().length / machines;
	console.log(`${line}: ${machines} ready on ${browser.workerThreads().length} worker threads; power off by ${how}${busy ? `, workers busy ${busy} ms as they end` : ""}`);
	for (let round = 1; round <= Number(rounds); round++) {
		if (how === "guest") for (let n = 1; n <= machines; n++) void tool("shell_exec", { targets: `node${n}`, command: "sudo poweroff" });
		else void tool("machines_poweroff", { names: "all" });
		await until("off", () => all("off"));
		const since = Date.now();
		// Chromium ends a thread that sleeps in the kernel two seconds after it is told to.
		while (browser.workerThreads().length > left && Date.now() - since < 6000) await sleep(50);
		took.push(Date.now() - since);
		const threads = browser.workerThreads();
		const leaked = threads.length > left;
		if (leaked) leaks += (threads.length - left) / each;
		console.log(`round ${round}: ${threads.length} worker threads left, ${took.at(-1)} ms after off${leaked ? "  <-- LEAK" : ""}`);
		if (leaked) for (const thread of threads.slice(left)) console.log("  ", JSON.stringify(stackPrint(thread)));
		left = threads.length;
		await tool("machines_boot", { names: "all" });
		await until("ready again", () => all("ready"));
	}
	console.log(`${leaks} of ${Number(rounds) * machines} power-offs left their worker threads`);
	console.log(`ms until the threads had gone, by round: ${took.join(" ")}`);
} finally {
	await browser.close();
	site.close();
}
process.exit(0);
