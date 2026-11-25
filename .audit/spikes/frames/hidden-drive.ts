// Throwaway. Delay and rate between real guests in a tab that is visible, hidden, and hidden for more than five minutes.
// Raw CDP with no page emulation, so the tab is throttled as a person's is.  SPIKE_OUT=dir node hidden-drive.ts headless|headed long?
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const out = process.env.SPIKE_OUT as string;
const [mode, long] = process.argv.slice(2);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	const path = (req.url as string).split("?")[0];
	try {
		const body = readFileSync(join(out, path));
		res.setHeader("content-type", types[extname(path)] ?? "application/octet-stream");
		res.end(body);
	} catch {
		res.setHeader("content-type", "text/html");
		res.end("<title>another tab</title>");
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const profile = mkdtempSync(join(tmpdir(), "hidden-"));
const args = ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"];
args.push(mode === "headless" ? "--headless=new" : "--ozone-platform=x11");
const browser = spawn(chromiumExecutable() ?? "chromium", [...args, `${origin}/blank`], { stdio: ["ignore", "ignore", "pipe"] });
const cdp = await new Promise<string>((resolve) => {
	let text = "";
	browser.stderr.on("data", (d) => {
		text += d;
		const m = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(text);
		if (m) resolve(`http://127.0.0.1:${m[1]}`);
	});
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = async (url: string) => {
	const t = (await (await fetch(`${cdp}/json/new?${url}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
	const ws = new WebSocket(t.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r));
	let ids = 0;
	const pending = new Map<number, (m: any) => void>();
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(String(e.data));
		pending.get(m.id)?.(m);
	});
	return async (expression: string): Promise<any> => {
		const id = ++ids;
		const m: any = await new Promise((r) => {
			pending.set(id, r);
			ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
		});
		if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
		return m.result.result.value;
	};
};
const q = (a: number[], p: number) => a.toSorted((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const variants = [
	["main, page timers", { where: "main" }],
	["main, clock worker", { where: "main", clock: "worker" }],
	["fabric worker", { where: "worker" }],
] as const;
const started = Date.now();
const say = (s: string) => console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s  ${s}`);
const measure = async (name: string, ev: (e: string) => Promise<any>) => {
	const call = (fn: string, ...a: unknown[]) => ev(`lab.${fn}(${a.map((x) => JSON.stringify(x)).join(",")})`);
	const ping = async (n: number, gap: string) => {
		const { out } = await call("sh", 0, `sudo ping -c ${n} -i ${gap} -W 5 node2`, 90_000);
		const t = [...out.matchAll(/time=([\d.]+)/g)].map((m) => Number(m[1]));
		return `${t.length}/${n} p50 ${q(t, 0.5)} [${Math.min(...t)}-${Math.max(...t)}]`;
	};
	await call("conditions", 1, null);
	const parts = [`none ${await ping(20, "0.05")}`];
	for (const [d, n] of [[5, 20], [100, 20], [1000, 5]] as const) {
		await call("conditions", 1, { delayMs: d });
		parts.push(`${d} ms ${await ping(n, "0.2")}`);
	}
	await call("conditions", 1, { rate: 1_000_000 });
	const recv = call("sh", 1, "nc -l -p 9000 </dev/null | wc -c", 60_000);
	await wait(1500);
	await call("call", "reset");
	await call("sh", 0, "dd if=/dev/zero bs=64k count=8 2>/dev/null | nc -w 2 node2 9000", 60_000);
	const bytes = Number((await recv).out);
	const s = await call("call", "stats");
	parts.push(`1 Mbit/s: ${((bytes * 8) / 1000 / (s.last[1] - s.first[1])).toFixed(2)} Mbit/s over ${bytes} bytes`);
	await call("conditions", 1, null);
	say(`${name.padEnd(20)} ${await ev("document.visibilityState")}  ${parts.join("; ")}`);
};
const tabs: [string, (e: string) => Promise<any>][] = [];
try {
	for (const [name, o] of variants) {
		const ev = await open(`${origin}/lab.html?${encodeURIComponent(name)}`);
		await wait(1000);
		await ev(`lab.boot(${JSON.stringify({ design: "B", topology: "one", machines: 2, window: 0, rxLimit: 0, capture: true, image: "alpine", ...o })})`);
		tabs.push([name, ev]);
		await measure(name, ev);
		if (!long) {
			await fetch(`${cdp}/json/new?${origin}/blank`, { method: "PUT" });
			await wait(15_000);
			for (let i = 0; i < 3; i++) await measure(name, ev);
		}
	}
	if (long) {
		await fetch(`${cdp}/json/new?${origin}/blank`, { method: "PUT" });
		say("hidden");
		await wait(340_000);
		for (const [name, ev] of tabs) for (let i = 0; i < 2; i++) await measure(name, ev);
	}
} finally {
	browser.kill();
	await wait(1500);
	server.closeAllConnections();
	server.close();
	rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
