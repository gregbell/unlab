// Throwaway. Are a page's WebSocket messages held while its tab is hidden? The program on this computer sends a message
// every 100 ms and times the answer, from the page and from a worker, with no timer in either. Raw CDP, so the tab is
// throttled as a person's is.   node hidden-ws.ts [minutes hidden]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const minutes = Number(process.argv[2] ?? 7);
const dial = (who: string) => `
	const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/${who}");
	ws.binaryType = "arraybuffer";
	ws.onmessage = (e) => ws.send(e.data);
`;
const html = `<!doctype html><title>link</title><script>
	const PORT = location.port;
	navigator.locks.request("lab", () => new Promise(() => {}));
	${dial("page")}
	new Worker(URL.createObjectURL(new Blob(["const PORT=" + PORT + ";" + ${JSON.stringify(dial("worker"))}])));
</script>`;
const server = createServer((req, res) => {
	res.setHeader("content-type", "text/html");
	res.end(req.url === "/" ? html : "<title>another tab</title>");
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const samples: Record<string, number[]> = { page: [], worker: [] };
const open: Record<string, boolean> = {};
new WebSocketServer({ server }).on("connection", (ws, req) => {
	const who = (req.url as string).slice(1);
	open[who] = true;
	const sent = new Map<number, number>();
	let n = 0;
	const id = setInterval(() => {
		sent.set(++n, performance.now());
		ws.send(Buffer.from(Uint32Array.of(n).buffer));
	}, 100);
	ws.on("message", (m: Buffer) => {
		const k = m.readUInt32LE(0);
		samples[who].push(performance.now() - (sent.get(k) as number));
		sent.delete(k);
	});
	ws.on("close", () => {
		open[who] = false;
		clearInterval(id);
	});
});
const profile = mkdtempSync(join(tmpdir(), "link-"));
const browser = spawn(
	chromiumExecutable() ?? "chromium",
	["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--headless=new", origin],
	{ stdio: ["ignore", "ignore", "pipe"] },
);
const cdp = await new Promise<string>((resolve) => {
	let text = "";
	browser.stderr.on("data", (d) => {
		text += d;
		const m = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(text);
		if (m) resolve(`http://127.0.0.1:${m[1]}`);
	});
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Target {
	readonly url: string;
	readonly type: string;
	readonly webSocketDebuggerUrl: string;
}
const visibility = async () => {
	const list = (await (await fetch(`${cdp}/json`)).json()) as Target[];
	const page = list.find((t) => t.type === "page" && t.url === `${origin}/`);
	if (!page) return "page not found";
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r));
	const answer = new Promise<string>((r) =>
		ws.addEventListener("message", (e) => r(JSON.parse(String(e.data)).result.result.value)),
	);
	ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.visibilityState" } }));
	const v = await answer;
	ws.close();
	return v;
};
const phase = async (name: string, seconds: number) => {
	for (const k of ["page", "worker"]) samples[k].length = 0;
	await wait(seconds * 1000);
	for (const k of ["page", "worker"]) {
		const a = samples[k].toSorted((x, y) => x - y);
		const at = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))]?.toFixed(1);
		console.log(
			`${name.padEnd(22)} ${k.padEnd(7)} open=${open[k]} n=${a.length}/${seconds * 10} p50 ${at(0.5)} p99 ${at(0.99)} max ${at(1)} ms`,
		);
	}
};
try {
	await wait(3000);
	console.log(`at the start: ${await visibility()}`);
	await phase("visible", 10);
	await fetch(`${cdp}/json/new?${origin}/blank`, { method: "PUT" });
	await wait(1000);
	console.log(`after another tab: ${await visibility()}`);
	await phase("hidden, first minute", 30);
	await wait(Math.max(0, minutes * 60_000 - 60_000));
	await phase(`hidden, ${minutes} min`, 30);
	console.log(`at the end: ${await visibility()}`);
} finally {
	browser.kill();
	await wait(1000);
	rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
