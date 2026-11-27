// Builds each lab of story 3.2's last two boxes in the built app, by typed commands alone, and saves the Topology
// window as a person sees it: as it opens, maximized, and in a narrow browser window. Beside each picture it prints
// what `unreadable` (test/support/topology.ts, the browser tests' own check) finds in that window.
//
//   npx vite build --outDir <dist>
//   node .audit/phase2/topology-visuals/look.mjs <dist> <dir for the pictures> [case ...]
//
// It serves <dist> itself on a free port, so it never meets another run's preview server.

import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";
import { unreadable } from "../../../test/support/topology.ts";

const [dir, out] = process.argv.slice(2, 4).map((path) => resolve(path));
const only = process.argv.slice(4);
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const LONGEST = "the-longest-name-a-machine-can-have-is-sixty-three-characters-x";
const leaves = ["switch0", "lan", "wan", "dmz", "edge", "office", "labs"];

/** Each lab: the lines that build it, the lines typed once its machines are ready, and what to do before a picture. */
const CASES = {
	// 16 machines on eight switches: long names, VLANs, trunks, a delayed cable, a blocked port and a storm.
	crowd: {
		build: [
			...["lan", "wan", "dmz", "core", "edge", "office", "labs"].map((name) => `mkswitch ${name}`),
			...leaves.map((leaf, i) => `cable core:${i + 1} ${leaf}:8`),
			"spawn 1 alpine --name internal-router-east --nics 2 --net switch0,lan --no-gateway",
			"spawn 1 alpine --name database-server-west --no-gateway",
			"spawn 1 alpine --name backup-storage-south --nics 2 --net switch0,wan --no-gateway",
			"spawn 2 alpine --net lan --no-gateway",
			"spawn 3 alpine --net wan --no-gateway",
			...["dmz", "edge", "office", "labs"].map((on) => `spawn 2 alpine --net ${on} --no-gateway`),
		],
		then: [
			"vlan lan:1 10",
			"vlan wan:1 20",
			"vlan dmz:1 30",
			"trunk core:2 --allow 1,10,20",
			"trunk lan:8 --allow 1,10,20",
			"link up core:3 --delay 20ms",
			"cable edge:7 office:7",
			"stp on core,edge,office",
			"cable labs:6 labs:7",
		],
		storm: "node15",
		expect: { machines: 16, switches: 8 },
	},
	// A machine on two switches that are cabled together shares a column with one of them.
	shared: {
		build: [
			"mkswitch lan",
			"cable switch0 lan",
			"spawn 2 alpine --no-gateway",
			"spawn 1 alpine --name router --nics 2 --net switch0,lan --no-gateway",
			"spawn 1 alpine --net lan --no-gateway",
		],
	},
	// Names of 38, 35, 20 and 63 characters, the longest a name can be, one above the other.
	wrap: {
		build: [
			"mkswitch lan",
			"spawn 1 alpine --name internal-router-east-building-two-rack --nics 2 --net switch0,lan --no-gateway",
			"spawn 1 alpine --name database-server-west-building-two-x --no-gateway",
			"spawn 1 alpine --name backup-storage-south --nics 2 --net switch0,lan --no-gateway",
			`spawn 1 alpine --name ${LONGEST} --no-gateway`,
			"spawn 1 alpine --net lan --no-gateway",
		],
	},
	// A switch cabled to itself, twice, beside one cabled to it.
	self: {
		build: [
			"mkswitch lan",
			"cable switch0 lan",
			"cable lan lan",
			"cable lan lan",
			"spawn 2 alpine --no-gateway",
			"spawn 1 alpine --net lan --no-gateway",
		],
	},
	// Four cables between one pair of switches: one carries, the tree blocks two, and one is cut. A machine's cable is
	// cut too, and a machine is off.
	pair: {
		build: [
			"mkswitch lan",
			...[1, 2, 3, 4].map((n) => `cable switch0:${n} lan:${n}`),
			"spawn 2 alpine --no-gateway",
			"spawn 2 alpine --net lan --no-gateway",
		],
		then: ["stp on all", "link down switch0:4", "link down node2", "poweroff node4"],
		// The picture of a selected node and one with the keyboard's focus.
		select: "lan",
		focus: "node1",
	},
	// Eight switches in a row and a machine at each end: nine columns, wider than the window as it opens.
	chain: {
		build: [
			...["lan", "wan", "dmz", "core", "edge", "office", "labs"].map((name) => `mkswitch ${name}`),
			...["switch0", "lan", "wan", "dmz", "core", "edge", "office"].map((name, i, all) => `cable ${name} ${all[i + 1] ?? "labs"}`),
			"spawn 1 alpine --no-gateway",
			"spawn 1 alpine --net labs --no-gateway",
		],
	},
	// Nodes with no cable between them: a switch with nothing in it, and two machines that are unplugged.
	islands: {
		build: ["mkswitch lan", "spawn 1 alpine --no-gateway", "spawn 2 alpine --no-net"],
	},
};

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

/** A page on the app with the case's lab built in it, every machine at its prompt. */
async function built(spec, viewport) {
	const context = await browser.newContext({ viewport });
	const page = await context.newPage();
	page.on("pageerror", (e) => console.log(`   PAGE ERROR ${e}`));
	await page.goto(`http://127.0.0.1:${server.address().port}/`);
	await page.waitForFunction(async () => (await document.modelContext.getTools()).some((tool) => tool.name === "link_set"));
	await page.getByRole("region", { name: "Welcome to unLAB" }).waitFor();
	const typed = async (line) => {
		await page.keyboard.press("Control+/");
		await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
		await page.keyboard.type(line);
		await page.keyboard.press("Enter");
		await wait(350);
		const bar = (await page.locator("unlab-command-bar").innerText()).replace(/\s+/g, " ").trim();
		if (bar.includes("esc close")) {
			console.log(`   REFUSED ${line} => ${bar}`);
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape");
		}
	};
	const state = (pick) => page.evaluate(`(${pick})(document.querySelector("unlab-app").services.store.state)`);
	for (const line of spec.build) await typed(line);
	await page.waitForFunction(
		() => Object.values(document.querySelector("unlab-app").services.store.state.machines).every((m) => m.life.phase === "ready"),
		null,
		{ timeout: 180_000 },
	);
	for (const line of spec.then ?? []) await typed(line);
	if (spec.storm) {
		await page.evaluate(async (machine) => {
			const tool = (await document.modelContext.getTools()).find((tool) => tool.name === "shell_exec");
			await document.modelContext.executeTool(tool, { targets: machine, command: "sudo sh -c 'arping -c 1 -w 1 -I eth0 10.88.0.99; true'" });
		}, spec.storm);
		await page
			.waitForFunction(() => Object.keys(document.querySelector("unlab-app").services.store.state.storms).length > 0, null, { timeout: 10_000 })
			.catch(() => console.log("   NO STORM"));
	}
	// The spanning tree takes a moment to settle on what it blocks.
	await wait(spec.then?.some((line) => line.startsWith("stp")) ? 4000 : 800);
	if (spec.expect) {
		const counts = await state((s) => ({ machines: s.rail.length, switches: s.switches.length }));
		if (counts.machines !== spec.expect.machines || counts.switches !== spec.expect.switches)
			console.log(`   NOT THE LAB ASKED FOR: ${JSON.stringify(counts)}`);
	}
	return { context, page };
}

/** The window, raised above the others, as a picture and as what cannot be read in it. */
async function look(page, label, file) {
	const map = page.getByRole("region", { name: "Topology" });
	await map.locator("header").click({ position: { x: 120, y: 10 } });
	await page.mouse.move(2, 2);
	await wait(250);
	await map.screenshot({ path: join(out, `${file}.png`) });
	const found = await map.evaluate(unreadable);
	const lines = await map.evaluate((region) => {
		const count = {};
		for (const wire of region.querySelectorAll(".wire")) count[wire.dataset.state] = (count[wire.dataset.state] ?? 0) + 1;
		return `${region.querySelectorAll(".n-node").length} nodes, lines ${Object.entries(count).map(([state, n]) => `${n} ${state}`).join(", ")}`;
	});
	const box = await map.boundingBox();
	console.log(`== ${label} (${Math.round(box.width)} x ${Math.round(box.height)}): ${lines}`);
	console.log(found.length === 0 ? "   every name and note can be read" : found.map((what) => `   ${what}`).join("\n"));
}
const scrollTo = (page, where) =>
	page.getByRole("region", { name: "Topology" }).locator(".n-map-scroll").evaluate((box, where) => box.scrollTo(0, where === "end" ? box.scrollHeight : 0), where);

for (const [name, spec] of Object.entries(CASES)) {
	if (only.length > 0 && !only.includes(name)) continue;
	{
		const { context, page } = await built(spec, { width: 1440, height: 900 });
		const map = page.getByRole("region", { name: "Topology" });
		await look(page, `${name}, as the window opens`, `${name}-open`);
		if (name === "crowd") {
			await scrollTo(page, "end");
			await look(page, `${name}, as the window opens, scrolled to its end`, `${name}-open-end`);
			await scrollTo(page, "start");
		}
		if (spec.select) {
			await map.locator(`.n-node[data-switch="${spec.select}"], .n-node[data-machine="${spec.select}"]`).click();
			await map.locator("header").click({ position: { x: 120, y: 10 } });
			await map.locator(".dt-title").focus();
			for (let i = 0; i < 40 && !(await page.evaluate((name) => [document.activeElement?.dataset?.machine, document.activeElement?.dataset?.switch].includes(name), spec.focus)); i++)
				await page.keyboard.press("Tab");
			await wait(250);
			await map.screenshot({ path: join(out, `${name}-selected-and-focused.png`) });
			console.log(`== ${name}: ${spec.select} selected, and ${spec.focus} with the keyboard's focus`);
		}
		await page.getByRole("button", { name: "Maximize Topology" }).click();
		await wait(900);
		await look(page, `${name}, maximized`, `${name}-max`);
		if (name === "crowd") {
			await scrollTo(page, "end");
			await look(page, `${name}, maximized, scrolled to its end`, `${name}-max-end`);
			await page.setViewportSize({ width: 1440, height: 2400 });
			await wait(900);
			await look(page, `${name}, maximized on a screen tall enough for all of it`, `${name}-max-tall`);
		}
		await context.close();
	}
	{
		const { context, page } = await built(spec, { width: 480, height: 900 });
		// A narrow desktop starts with the window closed.
		await page.getByRole("button", { name: /Topology ↗/ }).click();
		await wait(600);
		await look(page, `${name}, in a browser window 480 wide`, `${name}-narrow`);
		if (name === "crowd") {
			await scrollTo(page, "end");
			await look(page, `${name}, in a browser window 480 wide, scrolled to its end`, `${name}-narrow-end`);
		}
		await context.close();
	}
}

await browser.close();
server.closeAllConnections();
server.close();
