// Where the page's thread spends a storm. Not a reported speed: the profiler slows the page.
//   node profile.mjs <unminified dist> triangle|mesh
import { readFileSync } from "node:fs";
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
	const { pathname } = new URL(req.url, "http://localhost");
	const path = pathname === "/" ? "/index.html" : pathname;
	res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
	try { res.end(readFileSync(join(dir, path))); } catch { res.statusCode = 404; res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?layout=classic`);
await page.getByRole("heading", { name: "Your Linux lab in a tab." }).waitFor();
const typed = async (line) => { await page.keyboard.press("Control+/"); await page.getByRole("combobox", { name: "Command" }).waitFor(); await page.keyboard.type(line); await page.keyboard.press("Enter"); await wait(150); };
const call = (name, input) => page.evaluate(async ([name, input]) => { const tool = (await document.modelContext.getTools()).find((t) => t.name === name); return JSON.parse(await document.modelContext.executeTool(tool, input)); }, [name, input]);
const LABS = {
	triangle: { lab: ["mkswitch lan", "mkswitch wan", "spawn 1 alpine", "spawn 1 alpine --net lan", "spawn 1 alpine --net wan"], cables: [["switch0", "lan"], ["lan", "wan"], ["wan", "switch0"]], n: 3 },
	mesh: { lab: ["mkswitch b", "mkswitch c", "mkswitch d", "spawn 1 alpine", "spawn 1 alpine --net b", "spawn 1 alpine --net c", "spawn 1 alpine --net d"], cables: [["switch0", "d"], ["b", "d"], ["c", "d"], ["switch0", "b"], ["switch0", "c"], ["b", "c"]], n: 4 },
};
const lab = LABS[topology];
for (const line of lab.lab) await typed(line);
await page.getByText(`${lab.n} of ${lab.n} ready`).waitFor({ timeout: 120000 });
for (const [from, to] of lab.cables) await call("switch_cable", { from, to });
await call("shell_exec", { targets: "node1", command: "sudo arping -c 1 -w 1 -I eth0 10.88.0.99; true" });
await wait(Number(process.env.AFTER ?? 8000));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await wait(4000);
const { profile } = await cdp.send("Profiler.stop");
const name = new Map(profile.nodes.map((n) => [n.id, `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`]));
const self = new Map();
for (const s of profile.samples ?? []) self.set(name.get(s), (self.get(name.get(s)) ?? 0) + 1);
const total = profile.samples?.length ?? 0;
console.log(`${topology}: ${total} samples`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 28)) console.log(`${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
await browser.close();
server.closeAllConnections();
server.close();
process.exit(0);
