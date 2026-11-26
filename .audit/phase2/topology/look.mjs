// Drives the built app's Topology window in real Chromium through each command of story 3.2, and saves what a person sees.
//
//   vite build
//   CHROMIUM_PATH=… node .audit/phase2/topology/look.mjs dist .audit/phase2/topology/<dir>
//
// After each command it prints the map as text: every node's label, every line's ends, state and marks, and every
// word the window holds that names a NIC, a port or a VLAN. Then it tabs through the window and reads what has focus.

import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const [dir, out] = process.argv.slice(2).map((path) => resolve(path));
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer((req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	const { pathname } = new URL(req.url, "http://localhost");
	const path = pathname === "/" ? "/index.html" : pathname;
	res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
	try {
		res.end(readFileSync(join(dir, path)));
	} catch {
		res.statusCode = 404;
		res.end();
	}
}).listen(0, "127.0.0.1");
await new Promise((done) => server.once("listening", done));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log(`PAGE ERROR ${e}`));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(async () => (await document.modelContext.getTools()).some((tool) => tool.name === "link_set"));
await page.evaluate(() => {
	window.__notReloaded = true;
});

const typed = async (line) => {
	await page.keyboard.press("Control+/");
	await page.getByRole("combobox", { name: "Command" }).waitFor();
	await page.keyboard.type(line);
	await page.keyboard.press("Enter");
	await wait(400);
	const bar = (await page.locator("unlab-command-bar").innerText()).replace(/\s+/g, " ").trim();
	if (bar.includes("esc close")) {
		console.log(`   ${line} => ${bar}`);
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	}
};
const ready = () =>
	page.waitForFunction(
		() => Object.values(document.querySelector("unlab-app").services.store.state.machines).every((m) => m.life.phase === "ready"),
		null,
		{ timeout: 180_000 },
	);
const call = (name, input) =>
	page.evaluate(
		async ([name, input]) => {
			const tool = (await document.modelContext.getTools()).find((tool) => tool.name === name);
			return JSON.parse(await document.modelContext.executeTool(tool, input));
		},
		[name, input],
	);
const map = page.getByRole("region", { name: "Topology" });

/** The map as text: nodes, then lines by the nodes their ends sit on. */
async function read(step) {
	const text = await map.evaluate((region) => {
		const nodes = [...region.querySelectorAll(".n-node")].map((n) => {
			const r = n.getBoundingClientRect();
			return { name: n.dataset.machine ?? n.dataset.switch, x: r.x + r.width / 2, y: r.y + r.height / 2, label: n.textContent.replace(/\s+/g, " ").trim(), description: n.getAttribute("aria-description") };
		});
		const nearest = (x, y) => nodes.reduce((a, b) => (Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b)).name;
		const svg = region.querySelector("svg.n-wires");
		const wires = [...region.querySelectorAll(".wire")].map((w) => {
			const m = svg.getScreenCTM();
			const len = w.getTotalLength();
			const at = (t) => {
				const p = w.getPointAtLength(t).matrixTransform(m);
				return nearest(p.x, p.y);
			};
			const s = getComputedStyle(w);
			const marks = [...w.attributes].filter((a) => a.name.startsWith("data-") && a.name !== "data-selected").map((a) => `${a.name.slice(5)}=${a.value}`);
			return `${at(0)} -- ${at(len)} [${marks.join(" ")}] stroke ${s.stroke} dash ${s.strokeDasharray}`;
		});
		const words = (region.innerText.match(/\beth\d\b|\bport \d\b|:\d\b|\bv(lan)?\s?\d+\b|\btrunk\b|\bblocked\b|\bstorming\b|\bimpaired\b|\bcut\b/gi) ?? []).join(" ");
		return [...nodes.map((n) => `  node ${n.label}${n.description ? `  [described: ${n.description}]` : ""}`), ...wires.map((w) => `  line ${w}`), `  words in the window: ${words || "(none)"}`].join("\n");
	});
	const notReloaded = await page.evaluate(() => window.__notReloaded === true);
	console.log(`== ${step}${notReloaded ? "" : "  (THE PAGE RELOADED)"}\n${text}`);
}
/** Raised above the terminals first, by its title, as a person would. */
async function shot(name) {
	await map.locator("header").click({ position: { x: 120, y: 10 } });
	await map.screenshot({ path: join(out, `${name}.png`) });
}

await typed("mkswitch lan");
await typed("spawn 2 lab --no-gateway");
await typed("spawn 1 lab --name router --nics 2 --no-gateway");
await typed("spawn 1 lab --net lan --no-gateway");
await ready();
await typed("plug router:eth1 lan");
await read("two switches, node1 and node2 on switch0, router eth0 on switch0 and eth1 on lan, node4 on lan");
await shot("01-wired");

await typed("cable switch0 lan");
await read("cable switch0 lan");
await shot("02-cabled");

await typed("plug node2 lan:5");
await read("plug node2 lan:5 (a moved cable)");
await shot("03-moved");

await typed("link down router:eth1");
await read("link down router:eth1 (a cut NIC cable)");
await typed("link down switch0:4");
await read("link down switch0:4 (a cut cable between switches)");
await shot("04-cut");
await typed("link up router:eth1");
await typed("link up switch0:4");

await typed("link up node1 --delay 50ms --loss 10%");
await read("link up node1 --delay 50ms --loss 10% (an impaired cable)");
await shot("05-impaired");
await typed("link up node1 --clear");

await typed("vlan node4 10");
await typed("trunk switch0:4 --allow 1,10 --native 1");
await read("vlan node4 10; trunk switch0:4 --allow 1,10");
await shot("06-vlans");
console.log(`   topology_read says: ${JSON.stringify((await call("topology_read", {})).data.switches.map((s) => s.ports.filter((p) => p.vlan).map((p) => `${s.name}:${p.port} ${JSON.stringify(p.vlan)}`)).flat())}`);
await typed("vlan node4 1");
await typed("trunk switch0:4 --allow 1 --native 1");

await typed("cable lan lan");
await call("shell_exec", { targets: "node4", command: "sudo sh -c 'arping -c 1 -w 1 -I eth0 10.88.0.99; true'" });
await page.waitForFunction(() => Object.keys(document.querySelector("unlab-app").services.store.state.storms).length > 0, null, { timeout: 10_000 });
await read("cable lan lan, and a broadcast (a storm)");
await shot("07-storm");
await typed("uncable lan:6");
await page.waitForFunction(() => Object.keys(document.querySelector("unlab-app").services.store.state.storms).length === 0, null, { timeout: 10_000 });
await read("uncable lan:6 (the storm ends)");

await typed("uncable switch0:4");
await read("uncable switch0:4");
await typed("plug node2 switch0:2");
await typed("cable switch0 lan");

console.log("== keyboard: Tab from the Topology window's title bar, 12 times");
await map.locator("header button").first().focus();
for (let i = 0; i < 12; i++) {
	await page.keyboard.press("Tab");
	const f = await page.evaluate(() => {
		const el = document.activeElement;
		const inMap = !!el?.closest('[aria-label="Topology"]');
		const s = getComputedStyle(el);
		return `${inMap ? "in map" : "outside"} <${el.tagName.toLowerCase()} class="${el.className}"> name "${el.getAttribute("aria-label") ?? el.textContent.replace(/\s+/g, " ").trim().slice(0, 70)}" outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} pressed=${el.getAttribute("aria-pressed")}`;
	});
	console.log(`  Tab ${i + 1}: ${f}`);
}
await map.locator(".n-node").first().focus();
await page.keyboard.press("ArrowRight");
console.log(`  ArrowRight from the first node: focus on ${await page.evaluate(() => document.activeElement.textContent.replace(/\s+/g, " ").trim().slice(0, 50))}`);
await map.locator("header").click({ position: { x: 120, y: 10 } });
await map.locator("header button").first().focus();
for (let i = 0; i < 12 && !(await page.evaluate(() => document.activeElement?.dataset?.machine === "router")); i++) await page.keyboard.press("Tab");
await map.screenshot({ path: join(out, "08-focus.png") });
await page.keyboard.press("Enter");
await wait(400);
console.log(`  Enter on router: windows now ${JSON.stringify(await page.locator("section.dt-window").evaluateAll((ws) => ws.filter((w) => !w.hidden).map((w) => w.getAttribute("aria-label"))))}`);
const snapshot = await map.ariaSnapshot();
console.log(`== the Topology window's accessibility tree\n${snapshot}`);
await page.screenshot({ path: join(out, "desktop.png") });

await browser.close();
server.closeAllConnections();
server.close();
