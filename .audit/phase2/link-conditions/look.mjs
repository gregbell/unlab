// Drives the built app in real Chromium with a bad cable, and saves what a person sees of it.
//
//   vite build
//   node .audit/phase2/link-conditions/look.mjs dist <dir for the pictures>
//
// It prints what each command answered, the rows of the capture, and what the page shows of the cable.

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

async function lab(layout) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on("pageerror", (e) => console.log(`PAGE ERROR ${e}`));
	await page.goto(`http://127.0.0.1:${server.address().port}/${layout}`);
	await page.waitForFunction(async () => (await document.modelContext.getTools()).some((tool) => tool.name === "link_set"));
	const call = (name, input) =>
		page.evaluate(
			async ([name, input]) => {
				const tool = (await document.modelContext.getTools()).find((tool) => tool.name === name);
				return JSON.parse(await document.modelContext.executeTool(tool, input));
			},
			[name, input],
		);
	/** A line as a person types it, for what a tool would ask a person about. */
	const typed = async (line) => {
		await page.keyboard.press("Control+/");
		await page.getByRole("combobox", { name: "Command" }).waitFor();
		await page.keyboard.type(line);
		await page.keyboard.press("Enter");
		await wait(300);
	};
	const ready = () =>
		page.waitForFunction(
			() => {
				const machines = Object.values(document.querySelector("unlab-app").services.store.state.machines);
				return machines.length > 0 && machines.every((m) => m.life.phase === "ready");
			},
			null,
			{ timeout: 120_000 },
		);
	return { page, call, typed, ready, sh: async (machine, command) => (await call("shell_exec", { targets: machine, command })).data.ran[0].output };
}

{
	const { page, call, typed, ready, sh } = await lab("?layout=classic");
	console.log("== classic");
	await typed("spawn 2 alpine");
	await ready();
	console.log(JSON.stringify(await call("link_set", { link: "up", machines: "node1", delay: "100ms", loss: "20%" })));
	console.log(await sh("node1", "ping -c 10 -i 0.2 -W 1 node2 | tail -3"));
	console.log(JSON.stringify(await call("link_set", { link: "up", machines: "node1", mtu: 1400 })));
	console.log(await sh("node1", "ping -c 1 -W 1 -s 1400 node2 | tail -2"));
	console.log(JSON.stringify((await call("topology_read", {})).data.switches[0].ports.slice(0, 2)));
	console.log((await call("capture_read", { filter: "icmp", limit: 8 })).rows.map((row) => `${row.info} | ${row.note}`).join("\n"));
	const port = page.locator("unlab-switch .port[data-port='1']");
	console.log("faceplate:", await port.innerText(), "|", await port.getAttribute("title"));
	await page.screenshot({ path: join(out, "classic.png") });
	await page.locator("unlab-switch").screenshot({ path: join(out, "classic-faceplate.png") });
	await page.close();
}
{
	const { page, call, typed, ready, sh } = await lab("");
	console.log("== desktop");
	await typed("spawn 2 alpine");
	await typed("mkswitch lan");
	await typed("cable switch0 lan");
	await ready();
	console.log(JSON.stringify(await call("link_set", { link: "up", machines: "node1,switch0:3", delay: "50ms", loss: "30%" })));
	console.log(await sh("node1", "ping -c 10 -i 0.2 -W 1 node2 | tail -3"));
	await page.screenshot({ path: join(out, "desktop.png") });
	const texts = await page.evaluate(() => [...document.querySelectorAll(".dt-row small, .n-node-label small")].map((el) => el.textContent));
	console.log("desktop:", JSON.stringify(texts));
	await page.close();
}
await browser.close();
server.closeAllConnections();
server.close();
