// One broadcast on a cable from a trunk to an access port of one switch, in the shipped app in real Chromium.
//
//   vite build --outDir <dir>
//   node .audit/phase2/vlans/tagged-loop.mjs <dir> [seconds]
//
// It prints the longest frame the capture holds and the renderers' memory every 5 s, then cuts the cable, and
// says whether the storm ended and whether a ping still crosses a cable between two switches.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const [dir, secondsText] = process.argv.slice(2);
const seconds = Number(secondsText ?? 100);
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
await new Promise((resolve) => server.once("listening", resolve));

const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] });
const errors = [];
let code = 0;
try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on("crash", () => errors.push("page crashed"));
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`http://127.0.0.1:${server.address().port}/?layout=classic`);
	await page.getByRole("heading", { name: "Your Linux lab in a tab." }).waitFor();
	const typed = async (line) => {
		await page.keyboard.press("Control+/");
		await page.getByRole("combobox", { name: "Command" }).waitFor();
		await page.keyboard.type(line);
		await page.keyboard.press("Enter");
		await wait(150);
	};
	const call = (name, input) =>
		page.evaluate(
			async ([name, input]) => {
				const tool = (await document.modelContext.getTools()).find((tool) => tool.name === name);
				if (!tool) throw new Error(`${name} is not registered`);
				return JSON.parse(await document.modelContext.executeTool(tool, input));
			},
			[name, input],
		);
	const sh = async (machine, command) => {
		const reply = await call("shell_exec", { targets: machine, command });
		if (!reply.data) throw new Error(`${machine}: ${command}: ${JSON.stringify(reply)}`);
		return reply.data.ran[0];
	};
	const rss = async () => {
		const cdp = await browser.newBrowserCDPSession();
		const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
		await cdp.detach();
		return processInfo
			.filter((p) => p.type === "renderer")
			.reduce((sum, p) => sum + Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, "utf8"))?.[1] ?? 0) / 1024, 0);
	};
	const held = () =>
		page.evaluate(() => {
			const { capture } = document.querySelector("unlab-app").services;
			let longest = 0;
			let looped = 0;
			for (const e of capture.frames()) {
				longest = Math.max(longest, e.bytes.length);
				if (e.looped) looped++;
			}
			return { longest, looped, carried: capture.counters.in };
		});
	const storms = async () =>
		(await call("topology_read", {})).data.switches.filter((sw) => sw.storm).map((sw) => `${sw.name} ${sw.storm.rate}/s`);

	await typed("spawn 2 alpine --no-gateway");
	await page.getByText("2 of 2 ready").waitFor({ timeout: 120_000 });
	// The second switch is there for the last ping: it has to cross a cable, which the pump carries.
	for (const line of ["mkswitch lan", "plug node2 lan:1", "cable switch0:6 lan:8", "vlan switch0:6 10", "vlan node1 10"]) await typed(line);
	await wait(1000);
	const first = await sh("node1", "ping -c 2 -W 1 node2");
	for (const line of ["cable switch0:7 switch0:8", "trunk switch0:7", "vlan switch0:8 10"]) await typed(line);
	console.log(`before the broadcast: ping node2 across switch0:6 to lan:8 ${first.exitCode === 0 ? "answered" : "LOST"}; storms: ${(await storms()).join(", ") || "none"}; renderers ${(await rss()).toFixed(0)} MB`);

	const t0 = Date.now();
	await sh("node1", "sudo arping -c 1 -w 1 -I eth0 10.88.0.99; true");
	for (let s = 5; s <= seconds; s += 5) {
		while (Date.now() - t0 < s * 1000) await wait(50);
		const now = await held().catch((e) => ({ failed: String(e) }));
		console.log(`${s} s: ${JSON.stringify(now)}; renderers ${(await rss()).toFixed(0)} MB; page errors ${errors.length}${errors.length ? `: ${errors[0].slice(0, 120)}` : ""}`);
	}
	console.log(`storms before the cut: ${(await storms()).join(", ") || "none"}`);

	const cutAt = Date.now();
	await call("link_set", { link: "down", machines: "switch0:7" });
	let over = -1;
	while (Date.now() - cutAt < 5000) {
		if ((await storms()).length === 0) {
			over = Date.now() - cutAt;
			break;
		}
		await wait(10);
	}
	const last = await sh("node1", "ping -c 2 -W 1 node2");
	const after = await held();
	await wait(500);
	const still = (await held()).carried - after.carried;
	console.log(
		`after the cut: storm ${over < 0 ? "STILL ON after 5 s" : `over in ${over} ms`}; ping node2 across the cable ${last.exitCode === 0 ? "answered" : "LOST"}; ` +
			`longest frame held ${after.longest}; ${still} frames in the next 0.5 s; page errors ${errors.length}${errors.length ? `: ${[...new Set(errors)].join(" | ").slice(0, 300)}` : ""}`,
	);
	if (over < 0 || last.exitCode !== 0 || errors.length > 0) code = 1;
} finally {
	await browser.close();
	server.closeAllConnections();
	server.close();
}
process.exit(code);
