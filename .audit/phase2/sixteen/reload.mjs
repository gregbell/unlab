// Boots sixteen machines on two switches in the built app, reloads the page, and says whether the lab came back:
// the same machines on the same ports with the same hues, all ready, and a ping across each switch.
//
//   vite build
//   node .audit/phase2/sixteen/reload.mjs dist

import { resolve } from "node:path";
import { launch, serve, sleep } from "../worker-leak/browser.mjs";

const site = await serve(resolve(process.argv[2]));
const browser = await launch();
const tool = (name, input) =>
	browser
		.evaluate(`(async () => {
			const tool = (await document.modelContext.getTools()).find((tool) => tool.name === ${JSON.stringify(name)});
			try { return await document.modelContext.executeTool(tool, ${JSON.stringify(input)}); } catch (error) { return JSON.stringify({ threw: String(error) }); }
		})()`)
		.then((text) => JSON.parse(text));
async function until(what, test, ms = 300_000) {
	const deadline = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
}
const tools = () => browser.evaluate("document.modelContext?.getTools().then((tools) => tools.length > 5)").catch(() => false);
const ready = async () => {
	const machines = (await tool("machines_list", {})).data ?? [];
	return machines.length === 16 && machines.every((m) => m.state === "ready");
};
/** Each machine with its switch, port, address and hue, as the tools and the machine list have them. */
async function lab() {
	const machines = (await tool("machines_list", {})).data;
	const hues = await browser.evaluate(`[...document.querySelectorAll("unlab-machine-row .row")].map((row) => row.dataset.hue)`);
	return machines.map((m, i) => `${m.name} ${m.nics[0].switch}:${m.nics[0].port} ${m.address} hue ${hues[i]}`);
}

try {
	await browser.open(`http://127.0.0.1:${site.port}/?layout=classic`);
	await until("the tools", tools);
	await browser.typed("mkswitch lan");
	await browser.typed("spawn 8 alpine");
	for (let n = 1; n <= 8; n++) await browser.typed(`spawn 1 alpine --net lan --addr 10.2.0.${10 + n}/24`);
	await until("ready", ready);
	const before = await lab();
	await tool("shell_exec", { targets: "node1", command: "echo kept > ~/kept; sync" });

	const reloaded = Date.now();
	await browser.send("Page.reload");
	await sleep(500);
	await until("the tools again", tools);
	await until("ready again", ready);
	console.log(`16 machines ready ${((Date.now() - reloaded) / 1000).toFixed(1)} s after the reload, on ${browser.workerThreads().length} worker threads`);
	const after = await lab();
	console.log(JSON.stringify(after) === JSON.stringify(before) ? `the same sixteen, on the same ports with the same hues: ${after.join(", ")}` : `not the same: ${JSON.stringify({ before, after })}`);
	for (const [from, to] of [
		["node1", "10.88.0.18"],
		["node9", "10.2.0.18"],
	]) {
		const ran = (await tool("shell_exec", { targets: from, command: `ping -c 1 -W 5 ${to} >/dev/null && echo answered || echo no answer; cat ~/kept 2>/dev/null` })).data?.ran?.[0];
		console.log(`${from} pings ${to}: ${ran?.output?.replace("\n", ", ")}`);
	}
} finally {
	await browser.close();
	site.close();
}
process.exit(0);
