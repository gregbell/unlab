// Throwaway. SPIKE_OUT=dir node bench-drive.ts [runs]. One fresh page per measurement, sides alternating.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";
const runs = Number(process.argv[2] ?? 7);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	res.setHeader("content-type", types[extname(req.url ?? "")] ?? "application/octet-stream");
	try {
		res.end(readFileSync(join(process.env.SPIKE_OUT as string, req.url as string)));
	} catch {
		res.statusCode = 404;
		res.end();
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const med = (a: number[]) => {
	const s = a.toSorted((x, y) => x - y);
	return `${s[s.length >> 1].toFixed(s[0] < 20 ? 1 : 0)} [${s[0].toFixed(s[0] < 20 ? 1 : 0)}-${(s.at(-1) as number).toFixed(s[0] < 20 ? 1 : 0)}]`;
};
const all = new Map<string, { a: number[]; b: number[] }>();
const names = ["LabSwitch+queue", "lean TS", "Zig"];
for (let i = 0; i < runs; i++)
	for (const how of ["copying", "bare"])
		for (const t of ["one", "two"])
			for (const size of [64, 1514])
				for (const n of names) {
					const page = await browser.newPage();
					await page.goto(`${origin}/bench.html`);
					const r = await page.evaluate((a) => (window as any).bench.forward(...a), [n, t, size, how]);
					const k = `${how} ${t} ${size} B ${n}`;
					if (!all.has(k)) all.set(k, { a: [], b: [] });
					all.get(k)?.a.push(r.ns);
					all.get(k)?.b.push(r.worst);
					await page.close();
				}
for (let i = 0; i < runs; i++)
	for (const size of [64, 1514])
		for (const n of names) {
			const page = await browser.newPage();
			await page.goto(`${origin}/bench.html`);
			const r = await page.evaluate((a) => (window as any).bench.storm(...a), [n, size, true]);
			const k = `storm triangle ${size} B ${n}`;
			if (!all.has(k)) all.set(k, { a: [], b: [] });
			all.get(k)?.a.push(r.rate);
			all.get(k)?.b.push(r.gap);
			await page.close();
		}
for (const [k, { a, b }] of all) console.log(k.startsWith("storm") ? `${k.padEnd(40)} frames/s ${med(a)}  worst gap between 10 ms beats ms ${med(b)}` : `${k.padEnd(40)} ns/frame ${med(a)}  worst 1000 frames ms ${med(b)}`);
await browser.close();
server.closeAllConnections();
server.close();
process.exit(0);
