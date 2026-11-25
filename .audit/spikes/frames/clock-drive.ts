// Throwaway. Serves the built clock page, opens it in Chromium with no debugger attached, hides it by putting another
// tab of the same window in front, and prints what the page said at the end of each phase.
//   SPIKE_OUT=dir node clock-drive.ts headless|headed 20 60 400
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const out = process.env.SPIKE_OUT as string;
const [mode, visibleS, hiddenS, longS] = [process.argv[2], ...process.argv.slice(3).map(Number)] as [string, number, number, number];
let waiting: ServerResponse | undefined;
let reported: ((r: unknown) => void) | undefined;
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
	if (req.url === "/phase") {
		waiting = res;
		return;
	}
	if (req.url === "/report") {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			res.end("{}");
			reported?.(JSON.parse(body));
		});
		return;
	}
	try {
		res.setHeader("content-type", types[extname(req.url ?? "")] ?? "application/octet-stream");
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
		res.end(readFileSync(join(out, req.url === "/blank" ? "blank" : (req.url as string))));
	} catch {
		res.setHeader("content-type", "text/html");
		res.end("<title>another tab</title>");
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const profile = mkdtempSync(join(tmpdir(), "clock-"));
const args = ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=900,700"];
if (mode === "headless") args.push("--headless=new");
else args.push("--ozone-platform=x11");
const browser = spawn(chromiumExecutable() ?? "chromium", [...args, `${origin}/clock.html`], { stdio: ["ignore", "ignore", "pipe"] });
const cdp = await new Promise<string>((resolve, reject) => {
	let text = "";
	browser.stderr.on("data", (d) => {
		text += d;
		const m = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(text);
		if (m) resolve(`http://127.0.0.1:${m[1]}`);
	});
	browser.on("exit", () => reject(new Error(text)));
});
const phase = async (name: string) => {
	for (let i = 0; !waiting && i < 300; i++) await new Promise((r) => setTimeout(r, 100));
	const answer = new Promise((r) => (reported = r));
	waiting?.setHeader("content-type", "application/json");
	const w = waiting;
	waiting = undefined;
	w?.end(JSON.stringify({ phase: name }));
	return (await Promise.race([answer, new Promise((r) => setTimeout(() => r(null), 30_000))])) as Record<string, unknown> | null;
};
const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const show = (r: Record<string, unknown> | null) => {
	if (!r) return console.log("NO REPORT IN 30 s");
	console.log(`\n## ${r.phase}: visibilityState=${r.visibility} hasFocus=${r.hasFocus} states=${JSON.stringify((r.states as [number, string][]).map(([t, s]) => [((t - start) / 1000).toFixed(1), s]))} message round trips=${r.pings} worst ${(r.worstPing as number).toFixed(1)} ms`);
	for (const where of ["main", "worker"])
		for (const [k, v] of Object.entries(r[where] as Record<string, object>)) console.log(`${where.padEnd(7)}${k.padEnd(15)}${JSON.stringify(v)}`);
};
const start = Date.now();
try {
	await wait(2);
	await phase("warm-up");
	await wait(visibleS);
	show(await phase("visible"));
	// As a person does: the running browser is handed an address, and opens it in a tab in front.
	if (mode === "headless") await fetch(`${cdp}/json/new?${origin}/blank`, { method: "PUT" });
	else spawn(chromiumExecutable() ?? "chromium", [`--user-data-dir=${profile}`, `${origin}/blank`], { stdio: "ignore" });
	await wait(3);
	console.log("tabs", JSON.stringify(((await (await fetch(`${cdp}/json`)).json()) as { title: string; type: string }[]).map((x) => [x.type, x.title])));
	await phase("settling");
	await wait(hiddenS);
	show(await phase("hidden, first minutes"));
	if (longS) {
		await wait(Math.max(0, 320 - hiddenS));
		await phase("settling");
		await wait(longS);
		show(await phase("hidden, past five minutes"));
	}
} finally {
	const gone = new Promise((r) => browser.on("exit", r));
	browser.removeAllListeners("exit");
	browser.kill();
	await Promise.race([gone, wait(3)]);
	server.closeAllConnections();
	server.close();
	rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
