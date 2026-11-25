// Throwaway. The shipped app, unchanged: how fast a TCP transfer is and what each thread does, with the whole page drawn.
//   vite build --outDir dir at the repo's root, then: APP=dir node app-drive.ts 5
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };
const server = createServer((req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	const path = req.url === "/" ? "/index.html" : (req.url as string);
	res.setHeader("content-type", types[extname(path)] ?? "application/octet-stream");
	try {
		res.end(readFileSync(join(process.env.APP as string, path)));
	} catch {
		res.statusCode = 404;
		res.end();
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < Number(process.argv[2] ?? 1); i++) {
	const browser = await chromium.launch({ executablePath: chromiumExecutable() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
	const type = async (line: string) => {
		await page.keyboard.press("Control+/");
		await wait(150);
		await page.keyboard.type(line);
		await page.keyboard.press("Enter");
		await page.keyboard.press("Escape");
		await wait(300);
	};
	await page.getByRole("heading", { name: "Your Linux lab in a tab." }).waitFor();
	await type("spawn 2 alpine");
	await page.getByText("2 of 2 ready").waitFor({ timeout: 60_000 });
	await wait(1500);
	await type("exec node2 -- nc -l -p 9000 </dev/null >/dev/null &");
	await wait(1000);
	await type("exec node1 -- dd if=/dev/zero bs=64k count=16000 | nc -w 2 node2 9000");
	await wait(1000);
	const cdp = await browser.newBrowserCDPSession();
	const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
	const read = () => {
		const m = new Map<string, number>();
		for (const p of processInfo.filter((p) => p.type === "renderer" || p.type === "GPU"))
			for (const t of readdirSync(`/proc/${p.id}/task`)) {
				const text = readFileSync(`/proc/${p.id}/task/${t}/stat`, "utf8");
				const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
				m.set(`${t} ${p.type} ${text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"))}${t === String(p.id) ? " MAIN" : ""}`, Number(f[11]) + Number(f[12]));
			}
		return m;
	};
	const a = read();
	const t0 = Date.now();
	await wait(2000);
	const b = read();
	const secs = (Date.now() - t0) / 1000;
	const cpu = [...b].map(([k, v]) => [k, (v - (a.get(k) ?? 0)) / 100 / secs] as const).filter(([, v]) => v > 0.05).toSorted((x, y) => y[1] - x[1]).map(([k, v]) => `${k.replace(/^\d+ /, "")} ${v.toFixed(2)}`);
	await page.getByText(/copied, /).first().waitFor({ timeout: 30_000 });
	await wait(500);
	const text = (await page.locator("body").textContent()) ?? "";
	console.log(`run ${i}: ${/copied, ([\d.]+) seconds, ([\d.]+[MK]B\/s)/.exec(text)?.[0] ?? `no result in: ${text.slice(-300)}`}; threads: ${cpu.join(", ")}`);
	await browser.close();
}
server.closeAllConnections();
server.close();
process.exit(0);
