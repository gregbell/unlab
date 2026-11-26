// What the page's thread costs during a storm with each panel there or parked: which part of the page it is.
//   node probe.mjs <dist> triangle|mesh
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const [dir, topology] = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };
const server = createServer((req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
	res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
	try {
		res.end(readFileSync(join(dir, path)));
	} catch {
		res.statusCode = 404;
		res.end();
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
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
			const tool = (await document.modelContext.getTools()).find((t) => t.name === name);
			return JSON.parse(await document.modelContext.executeTool(tool, input));
		},
		[name, input],
	);
const LABS = {
	triangle: { lab: ["mkswitch lan", "mkswitch wan", "spawn 1 alpine", "spawn 1 alpine --net lan", "spawn 1 alpine --net wan"], cables: [["switch0", "lan"], ["lan", "wan"], ["wan", "switch0"]], n: 3 },
	mesh: { lab: ["mkswitch b", "mkswitch c", "mkswitch d", "spawn 1 alpine", "spawn 1 alpine --net b", "spawn 1 alpine --net c", "spawn 1 alpine --net d"], cables: [["switch0", "d"], ["b", "d"], ["c", "d"], ["switch0", "b"], ["switch0", "c"], ["b", "c"]], n: 4 },
};
const lab = LABS[topology];
for (const line of lab.lab) await typed(line);
await page.getByText(`${lab.n} of ${lab.n} ready`).waitFor({ timeout: 120000 });
for (const [from, to] of lab.cables) await call("switch_cable", { from, to });

const cdp = await browser.newBrowserCDPSession();
const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
const main = async () => {
	const read = () =>
		processInfo
			.filter((p) => p.type === "renderer")
			.flatMap((p) => {
				const text = readFileSync(`/proc/${p.id}/task/${p.id}/stat`, "utf8");
				const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
				return [Number(f[11]) + Number(f[12])];
			})
			.reduce((a, b) => a + b, 0);
	const a = read();
	const t = Date.now();
	const c0 = await page.evaluate(() => document.querySelector("unlab-app").services.capture.counters.in);
	await wait(3000);
	const c1 = await page.evaluate(() => document.querySelector("unlab-app").services.capture.counters.in);
	const secs = (Date.now() - t) / 1000;
	return `${((read() - a) / 100 / secs).toFixed(2)} core, ${((c1 - c0) / secs).toFixed(0)} frames/s`;
};
const ui = (event) => page.evaluate((event) => document.querySelector("unlab-app").services.store.dispatchUi(event), event);
console.log(`${topology}, before the storm: ${await main()}`);
await call("shell_exec", { targets: "node1", command: "sudo arping -c 1 -w 1 -I eth0 10.88.0.99; true" });
await wait(2000);
console.log(`storm, every panel open: ${await main()}`);
await ui({ type: "ui/panel-parked", panel: "capture" });
console.log(`storm, capture parked: ${await main()}`);
await ui({ type: "ui/panel-parked", panel: "switch0" });
console.log(`storm, capture and switches parked: ${await main()}`);
await ui({ type: "ui/panel-unparked", panel: "capture" });
console.log(`storm, switches parked: ${await main()}`);
await ui({ type: "ui/panel-unparked", panel: "switch0" });
await ui({ type: "ui/capture-pause", paused: true });
console.log(`storm, capture paused: ${await main()}`);
await browser.close();
server.closeAllConnections();
server.close();
process.exit(0);
