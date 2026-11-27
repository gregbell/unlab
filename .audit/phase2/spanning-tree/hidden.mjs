// Whether the spanning tree keeps its time while the lab's tab is hidden, in real Chromium, with the built app.
//
//   vite build, then
//   node .audit/phase2/spanning-tree/hidden.mjs <dist> [seconds hidden, 45 by default]
//
// It cables two switches twice, which is a loop, turns spanning tree on, and puts another tab in front. A page's own
// timers are then held to one a second, and with the feature below to one a minute after ten seconds, where a browser
// waits five minutes. A hello comes every two seconds, and what a port heard runs out after three of them, so a tree
// on the page's own timers would lose its neighbour and block and unblock ports. It prints when each hello crossed a
// cable, by the lab's capture, and whether the port that was blocked before is the one that is blocked after.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const [dist, secondsText = "45"] = process.argv.slice(2);
const seconds = Number(secondsText);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer((req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	const { pathname } = new URL(req.url, "http://localhost");
	const path = pathname === "/" ? "/index.html" : pathname;
	res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
	try {
		res.end(readFileSync(join(resolve(dist), path)));
	} catch {
		res.statusCode = 404;
		res.end();
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://localhost:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "unlab-stp-hidden-"));
const features = "WebMCP,IntensiveWakeUpThrottling:grace_period_seconds/10";
const child = spawn(
	chromiumExecutable(),
	["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-sandbox", `--enable-features=${features}`, `${origin}/?layout=classic`],
	{ stdio: ["ignore", "ignore", "pipe"] },
);
const cdp = await new Promise((done, fail) => {
	let printed = "";
	child.stderr.on("data", (text) => {
		printed += text;
		const match = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(printed);
		if (match) done(`http://127.0.0.1:${match[1]}`);
	});
	child.once("exit", () => fail(new Error(printed)));
});

/** Runs an expression in the lab's tab over a connection of its own, which is closed again: one that stays open can change what is measured. */
async function evaluate(expression) {
	const targets = await (await fetch(`${cdp}/json`)).json();
	const lab = targets.find(({ type, url }) => type === "page" && url.startsWith(`${origin}/?layout`));
	if (!lab) throw new Error("the lab's tab is gone");
	const socket = new WebSocket(lab.webSocketDebuggerUrl);
	await new Promise((r) => socket.addEventListener("open", r));
	const said = new Promise((r) => socket.addEventListener("message", (event) => r(JSON.parse(String(event.data)))));
	socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
	const reply = await said;
	socket.close();
	if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
	return reply.result?.result?.value;
}

/** Calls one of the lab's tools as an agent in the browser would. */
const call = async (name, input) =>
	JSON.parse(
		await evaluate(`(async () => {
			const tool = (await document.modelContext.getTools()).find((tool) => tool.name === ${JSON.stringify(name)});
			if (!tool) throw new Error("no tool ${name}");
			return document.modelContext.executeTool(tool, ${JSON.stringify(input)});
		})()`),
	);

const blocked = async () =>
	(await call("topology_read", {})).data.switches.flatMap(({ name, ports }) =>
		ports.flatMap(({ port, stp }) => (stp && stp.state !== "forwarding" ? [`${name}:${port} ${stp.role} ${stp.state}`] : [])),
	);
/** When each of the tree's messages crossed a cable, in seconds since the lab began, by the switch and port that took it in. */
const hellos = async () =>
	(await call("capture_read", { filter: "01:80:c2:00:00:00", limit: 1000 })).rows
		.filter((row) => row.kind === "frame")
		.map((row) => ({ at: Number(row.time), where: `${row.switch}:${row.in}` }));

try {
	for (let i = 0; i < 100 && (await evaluate("typeof document.modelContext?.getTools")) !== "function"; i++) await wait(100);
	for (let i = 0; i < 100 && (await evaluate("document.modelContext.getTools().then((tools) => tools.length)")) < 20; i++) await wait(100);
	await call("switch_add", { name: "lan" });
	await call("switch_cable", { from: "switch0:1", to: "lan:1" });
	await call("switch_cable", { from: "switch0:2", to: "lan:2" });
	console.log((await call("switch_stp", { stp: "on", switches: "all" })).result);
	await wait(6000);
	const before = await blocked();
	const shown = (await hellos()).length;
	console.log(`visible: ${await evaluate("document.visibilityState")}, blocked: ${before.join(", ")}, ${shown} messages so far`);

	await fetch(`${cdp}/json/new?${origin}/favicon.svg`, { method: "PUT" });
	for (let i = 0; i < 50 && (await evaluate("document.visibilityState")) !== "hidden"; i++) await wait(100);
	const hiddenAt = await evaluate("performance.now()");
	console.log(`the tab is ${await evaluate("document.visibilityState")}`);
	// How late the page's own timers are while it is hidden, for what the tree's would be without the worker.
	await evaluate(`(() => { window.late = []; let last = performance.now(); setInterval(() => { const now = performance.now(); window.late.push(Math.round(now - last)); last = now; }, 100); })()`);
	await wait(seconds * 1000);
	const state = await evaluate("document.visibilityState");
	const late = await evaluate("window.late");
	const after = await blocked();
	const all = await hellos();
	const during = all.filter(({ at }) => at * 1000 >= hiddenAt);
	const byPort = Map.groupBy(during, ({ where }) => where);
	console.log(`after ${seconds} s the tab is ${state}, blocked: ${after.join(", ")}`);
	console.log(`a page timer of 100 ms came every ${Math.min(...late)} to ${Math.max(...late)} ms while hidden (${late.length} times in ${seconds} s)`);
	for (const [where, rows] of byPort) {
		const gaps = rows.slice(1).map(({ at }, i) => Math.round((at - rows[i].at) * 1000));
		console.log(`${where} took in ${rows.length} messages while hidden, ${Math.min(...gaps)} to ${Math.max(...gaps)} ms apart`);
	}
	const storms = (await call("capture_read", { filter: "", limit: 1000 })).rows.filter((row) => row.kind === "storm").length;
	console.log(`storms: ${storms}`);
	const same = before.join() === after.join() && before.length === 1;
	console.log(same ? "the same one port was blocked before and after" : "THE BLOCKED PORT CHANGED");
	process.exitCode = same && storms === 0 ? 0 : 1;
} finally {
	child.kill();
	server.close();
	await wait(1000);
	rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
