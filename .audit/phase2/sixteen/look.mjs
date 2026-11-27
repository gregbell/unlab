// Boots sixteen machines on eight switches in the built app's desktop, and looks at the Topology window: a
// picture of it as it opens and maximized, and whether any name or note is under another node or a line.
//
//   vite build
//   node .audit/phase2/sixteen/look.mjs dist <dir for the pictures>
//
// The lab is the one that src/ui/desktop/topology.browser.test.ts draws from the model alone: seven switches
// cabled to core, a machine with a NIC on each of switch0, lan and wan, VLANs, a trunk and a cable with a delay.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launch, serve, sleep } from "../worker-leak/browser.mjs";

const [dir, out] = process.argv.slice(2).map((path) => resolve(path));
mkdirSync(out, { recursive: true });
const site = await serve(dir);
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
async function shot(name) {
	const { data } = await browser.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`${out}/${name}.png`, Buffer.from(data, "base64"));
}

/** What makes a name or a note hard to read, as the browser test counts it. */
const UNREADABLE = `(() => {
	const map = document.querySelector('[aria-label="Topology"]');
	const parts = [...map.querySelectorAll(".n-node")].flatMap((node) => {
		const who = node.dataset.machine ?? node.dataset.switch ?? "?";
		return [
			{ who, what: "node", rect: node.getBoundingClientRect() },
			{ who, what: "name", rect: node.querySelector("strong")?.getBoundingClientRect() },
			{ who, what: "note", rect: node.querySelector("small")?.getBoundingClientRect() },
		];
	});
	const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
	const matrix = map.querySelector("svg.n-wires")?.getScreenCTM() ?? undefined;
	const lines = [...map.querySelectorAll(".wire")].map((wire) =>
		Array.from({ length: 200 }, (_, i) => wire.getPointAtLength((i / 199) * wire.getTotalLength()).matrixTransform(matrix)),
	);
	const names = parts.filter((p) => p.what === "name");
	const notes = parts.filter((p) => p.what === "note");
	const drawing = map.querySelector(".n-drawing").getBoundingClientRect();
	return {
		nodes: names.map((name) => name.who),
		unreadable: [
			...notes.flatMap((note) => parts.filter((other) => other.who !== note.who && other.what === "node" && note.rect && other.rect && meet(note.rect, other.rect)).map((other) => note.who + "'s note under " + other.who + "'s node")),
			...names.flatMap((name) => parts.filter((other) => other.who !== name.who && name.rect && other.rect && meet(name.rect, other.rect)).map((other) => name.who + "'s name under " + other.who + "'s " + other.what)),
			...names.flatMap((name) => lines.some((line) => line.some((p) => name.rect && p.x > name.rect.left && p.x < name.rect.right && p.y > name.rect.top && p.y < name.rect.bottom)) ? ["a line across " + name.who + "'s name"] : []),
			...names.flatMap((name) => name.rect && (name.rect.left < drawing.left || name.rect.right > drawing.right || name.rect.bottom > drawing.bottom) ? [name.who + "'s name outside the drawing"] : []),
		],
	};
})()`;

try {
	await browser.open(`http://127.0.0.1:${site.port}/`);
	await until("the tools", () => browser.evaluate("document.modelContext?.getTools().then((tools) => tools.length > 5)").catch(() => false));
	const started = Date.now();
	const leaves = ["switch0", "lan", "wan", "dmz", "edge", "office", "labs"];
	for (const name of ["lan", "wan", "dmz", "core", "edge", "office", "labs"]) await browser.typed(`mkswitch ${name}`);
	for (const [i, leaf] of leaves.entries()) await browser.typed(`cable core:${i + 1} ${leaf}:8`);
	await browser.typed("spawn 2 alpine");
	await browser.typed("spawn 1 alpine --nics 4 --net switch0,lan,wan,switch0");
	await browser.typed("spawn 2 alpine --net lan");
	await browser.typed("spawn 3 alpine --net wan");
	for (const on of ["dmz", "edge", "office", "labs"]) await browser.typed(`spawn 2 alpine --net ${on}`);
	await until("sixteen machines", async () => ((await tool("machines_list", {})).data ?? []).length === 16);
	await until("ready", async () => ((await tool("machines_list", {})).data ?? []).every((m) => m.state === "ready"));
	console.log(`16 machines on 8 switches ready ${((Date.now() - started) / 1000).toFixed(1)} s after the first command`);
	for (const line of ["vlan lan:1 10", "vlan wan:1 20", "vlan dmz:1 30", "trunk core:2 --allow 1,10,20", "trunk lan:8 --allow 1,10,20", "link up core:3 --delay 20ms"])
		await browser.typed(line);
	await sleep(1500);
	const refused = await browser.evaluate(`document.querySelector("unlab-command-bar [role=alert]")?.innerText ?? ""`);
	if (refused) throw new Error(`a line was refused: ${refused}`);
	const wiring = (await tool("topology_read", {})).data.switches.flatMap((on) =>
		on.ports.flatMap((port) => {
			const vlan = port.vlan?.mode === "trunk" ? `trunk ${port.vlan.allowed}` : port.vlan?.vlan > 1 ? `vlan ${port.vlan.vlan}` : "";
			const conditions = Object.entries(port.cable?.conditions ?? {}).map(([part, value]) => `${part} ${value}`).join(" ");
			return vlan || conditions ? [`${on.name}:${port.port} ${[vlan, conditions].filter(Boolean).join(" ")}`] : [];
		}),
	);
	console.log(`VLANs, trunks and conditions: ${wiring.join(", ")}`);
	console.log(`status bar: ${await browser.evaluate(`document.querySelector('[aria-label="Lab status"]').innerText.replace(/\\s+/g, " ")`)}`);
	await shot("desktop-16");
	const opened = await browser.evaluate(UNREADABLE);
	console.log(`Topology as it opens: ${opened.nodes.length} nodes; ${opened.unreadable.length === 0 ? "every name and note can be read" : opened.unreadable.join("; ")}`);
	await browser.evaluate(`document.querySelector('button[aria-label="Maximize Topology"]').click()`);
	await sleep(1200);
	await shot("topology-16-maximized");
	const maximized = await browser.evaluate(UNREADABLE);
	console.log(`Topology maximized: ${maximized.nodes.length} nodes; ${maximized.unreadable.length === 0 ? "every name and note can be read" : maximized.unreadable.join("; ")}`);
} finally {
	await browser.close();
	site.close();
}
process.exit(0);
