// Measures the shipped app in real Chromium, with real guests, one lab at a time.
//
//   vite build --outDir <dir>           in each checkout to compare
//   node drive.mjs tcp <runs> <label>=<dir> [<label>=<dir>]   TCP between two guests, sides alternating
//                                                              ONLY=one keeps to the lab of one switch
//   node drive.mjs storm <runs> <dir> triangle|mesh [seconds]  one broadcast round a loop, and its cut
//
// A side that cannot add switches runs only the lab of one. Each line that starts with `run` is one run.

import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const [what, runsText, ...rest] = process.argv.slice(2);
const runs = Number(runsText);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

function serve(dir) {
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
	return new Promise((resolve) => server.once("listening", () => resolve(server)));
}

const q = (a, p) => a.toSorted((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const med = (a, d = 0) => `${q(a, 0.5).toFixed(d)} [${Math.min(...a).toFixed(d)}-${Math.max(...a).toFixed(d)}]`;

/** A lab on a page of its own, driven as a person and an agent drive it. */
async function withLab(dir, fn) {
	const server = await serve(dir);
	const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] });
	const errors = [];
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on("crash", () => errors.push("page crashed"));
		page.on("pageerror", (e) => errors.push(String(e)));
		await page.goto(`http://127.0.0.1:${server.address().port}/`);
		await page.getByRole("heading", { name: "Your Linux lab in a tab." }).waitFor();
		const lab = {
			page,
			browser,
			errors,
			async typed(line) {
				await page.keyboard.press("Control+/");
				await page.getByRole("combobox", { name: "Command" }).waitFor();
				await page.keyboard.type(line);
				await page.keyboard.press("Enter");
				await wait(150);
			},
			ready: (text) => page.getByText(text).waitFor({ timeout: 120_000 }),
			call: (name, input) =>
				page.evaluate(
					async ([name, input]) => {
						const tool = (await document.modelContext.getTools()).find((tool) => tool.name === name);
						if (!tool) throw new Error(`${name} is not registered`);
						return JSON.parse(await document.modelContext.executeTool(tool, input));
					},
					[name, input],
				),
			async sh(machine, command) {
				const reply = await lab.call("shell_exec", { targets: machine, command });
				if (!reply.data) throw new Error(`${machine}: ${command}: ${JSON.stringify(reply)}`);
				return reply.data.ran[0];
			},
			/** Frames that switches have accepted since the lab began. */
			carried: () => page.evaluate(() => document.querySelector("unlab-app").services.capture.counters.in),
		};
		return await fn(lab);
	} finally {
		await browser.close();
		server.closeAllConnections();
		server.close();
	}
}

/** Megabytes that each renderer of the browser holds, added up. */
async function rss(browser) {
	const cdp = await browser.newBrowserCDPSession();
	const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
	await cdp.detach();
	return processInfo
		.filter((p) => p.type === "renderer")
		.reduce((sum, p) => sum + Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, "utf8"))?.[1] ?? 0) / 1024, 0);
}

/** Cores that each busy thread of the renderers used over a second, by its name. */
async function busy(browser) {
	const cdp = await browser.newBrowserCDPSession();
	const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
	await cdp.detach();
	const read = () => {
		const m = new Map();
		for (const p of processInfo.filter((p) => p.type === "renderer"))
			for (const t of readdirSync(`/proc/${p.id}/task`)) {
				try {
					const text = readFileSync(`/proc/${p.id}/task/${t}/stat`, "utf8");
					const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
					m.set(`${t} ${text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"))}${t === String(p.id) ? " MAIN" : ""}`, Number(f[11]) + Number(f[12]));
				} catch {}
			}
		return m;
	};
	const a = read();
	const t = Date.now();
	await wait(1000);
	const b = read();
	const secs = (Date.now() - t) / 1000;
	return [...b]
		.map(([k, v]) => [k, (v - (a.get(k) ?? 0)) / 100 / secs])
		.filter(([, v]) => v > 0.04)
		.toSorted((x, y) => y[1] - x[1])
		.slice(0, 6)
		.map(([k, v]) => `${k.replace(/^\d+ /, "")} ${v.toFixed(2)}`)
		.join(", ");
}

const LABS = {
	one: ["spawn 2 alpine"],
	"one cable": ["mkswitch lan", "spawn 1 alpine", "spawn 1 alpine --net lan", "cable switch0 lan"],
	"two cables": ["mkswitch lan", "mkswitch wan", "spawn 1 alpine", "spawn 1 alpine --net wan", "cable switch0 lan", "cable lan wan"],
};

/** MiB sent from node1 to node2, which discards them, and how fast: by dd's own clock and by the receiver's NIC. */
async function transfer(lab, mib) {
	// The shell may say after the number that the listener of the last transfer is done.
	const rx = async () => Number(/^(\d+)\s*$/m.exec((await lab.sh("node2", "cat /sys/class/net/eth0/statistics/rx_bytes")).output)?.[1]);
	await lab.sh("node2", "nc -l -p 9000 </dev/null >/dev/null &");
	await wait(400);
	const before = await rx();
	const sent = await lab.sh("node1", `dd if=/dev/zero bs=64k count=${mib * 16} | nc -w 2 node2 9000`);
	const seconds = Number(/copied, ([\d.]+) seconds/.exec(sent.output)?.[1]);
	const got = (await rx()) - before;
	if (sent.exitCode !== 0 || !seconds || !(got >= mib * 2 ** 20)) throw new Error(`short transfer: exit ${sent.exitCode}, ${got} bytes, ${sent.output}`);
	return { mbit: (mib * 2 ** 20 * 8) / 1e6 / seconds, got };
}

if (what === "tcp") {
	const sides = rest.map((arg) => arg.split("="));
	const topologies = process.env.ONLY ? process.env.ONLY.split(",") : Object.keys(LABS);
	const variants = sides.flatMap(([label, dir], i) => (i === 0 && sides.length > 1 ? ["one"] : topologies).map((topology) => ({ label, dir, topology })));
	const got = variants.map(() => ({ mbit: [], ping: [] }));
	for (let i = 0; i < runs; i++)
		for (const [v, { label, dir, topology }] of variants.entries())
			await withLab(dir, async (lab) => {
				for (const line of LABS[topology]) await lab.typed(line);
				await lab.ready("2 of 2 ready");
				await wait(1000);
				const ping = await lab.sh("node1", "ping -c 100 -i 0.01 -W 2 node2 | tail -1");
				const p50 = Number(/= [\d.]+\/([\d.]+)\//.exec(ping.output)?.[1]);
				await transfer(lab, 16);
				const t = await transfer(lab, 256);
				got[v].mbit.push(t.mbit);
				got[v].ping.push(p50);
				const cpu = i === 0 ? ` threads in a second transfer: ${await (async () => { const again = transfer(lab, 256); await wait(1200); const said = await busy(lab.browser); await again; return said; })()}` : "";
				console.log(`run ${i} ${label} ${topology}: ${t.mbit.toFixed(0)} Mbit/s, ping avg ${p50} ms, receiver took ${t.got} bytes${lab.errors.length ? ` ERRORS ${lab.errors}` : ""}${cpu}`);
			});
	for (const [v, { label, topology }] of variants.entries()) console.log(`${label} ${topology}: TCP Mbit/s ${med(got[v].mbit)}, ping avg ms ${med(got[v].ping, 2)}, n=${runs}`);
}

const STORMS = {
	triangle: {
		lab: ["mkswitch lan", "mkswitch wan", "spawn 1 alpine", "spawn 1 alpine --net lan", "spawn 1 alpine --net wan"],
		line: [["switch0", "lan"], ["lan", "wan"]],
		close: [["wan", "switch0"]],
		machines: 3,
		// One cut opens the only loop.
		cut: ["lan:2"],
	},
	mesh: {
		lab: ["mkswitch b", "mkswitch c", "mkswitch d", "spawn 1 alpine", "spawn 1 alpine --net b", "spawn 1 alpine --net c", "spawn 1 alpine --net d"],
		line: [["switch0", "d"], ["b", "d"], ["c", "d"]],
		close: [["switch0", "b"], ["switch0", "c"], ["b", "c"]],
		machines: 4,
		// Every loop has one of these three in it: what is left is a star.
		cut: ["switch0:3", "switch0:4", "b:4"],
	},
};

if (what === "storm") {
	const [dir, topology, secondsText] = rest;
	const seconds = Number(secondsText ?? 60);
	const storm = STORMS[topology];
	const all = {};
	const note = (k, v) => (all[k] ??= []).push(v);
	for (let i = 0; i < runs; i++)
		await withLab(dir, async (lab) => {
			const { page, browser } = lab;
			for (const line of storm.lab) await lab.typed(line);
			await lab.ready(`${storm.machines} of ${storm.machines} ready`);
			for (const [from, to] of storm.line) await lab.call("switch_cable", { from, to });
			await lab.sh("node1", "ping -c 2 -W 1 node2");
			await wait(1000);
			const before = await rss(browser);
			for (const [from, to] of storm.close) await lab.call("switch_cable", { from, to });
			await page.evaluate(() => {
				const probe = { gaps: [], paints: 0, on: true, at: performance.now() };
				const paint = () => {
					probe.paints++;
					if (probe.on) requestAnimationFrame(paint);
				};
				requestAnimationFrame(paint);
				let due = performance.now() + 20;
				const beat = () => {
					probe.gaps.push(performance.now() - due);
					due = performance.now() + 20;
					if (probe.on) setTimeout(beat, 20);
				};
				setTimeout(beat, 20);
				window.probe = probe;
			});
			const c0 = await lab.carried();
			const t0 = Date.now();
			await lab.sh("node1", "sudo arping -c 1 -w 1 -I eth0 10.88.0.99; true");
			const rates = [];
			const memory = [];
			const answers = [];
			let last = { at: Date.now(), carried: await lab.carried() };
			for (let s = 5; s <= seconds; s += 5) {
				while (Date.now() - t0 < s * 1000) await wait(50);
				const now = { at: Date.now(), carried: await lab.carried() };
				rates.push(Math.round(((now.carried - last.carried) * 1000) / (now.at - last.at)));
				last = now;
				memory.push(Math.round(await rss(browser)));
				const asked = Date.now();
				await lab.call("machines_list", {});
				const listed = Date.now() - asked;
				const echoed = Date.now();
				const said = await lab.sh("node2", "echo answered");
				if (!said.output.includes("answered")) throw new Error("no echo");
				answers.push([listed, Date.now() - echoed]);
			}
			const cpu = await busy(browser);
			const topo = await lab.call("topology_read", {});
			const storms = topo.data.switches.map((sw) => (sw.storm ? `${sw.name} ${sw.storm.rate}/s dropped ${sw.storm.dropped}` : `${sw.name} quiet`));
			const probe = await page.evaluate(() => {
				const p = window.probe;
				p.on = false;
				return { max: Math.max(...p.gaps), p99: p.gaps.toSorted((a, b) => a - b)[Math.floor(p.gaps.length * 0.99)], n: p.gaps.length, paints: (p.paints * 1000) / (performance.now() - p.at) };
			});
			const total = ((await lab.carried()) - c0) / ((Date.now() - t0) / 1000);

			const cutAt = Date.now();
			await lab.call("link_set", { link: "down", machines: storm.cut.join(",") });
			let over = 0;
			for (;;) {
				const now = await lab.call("topology_read", {});
				if (now.data.switches.every((sw) => !sw.storm)) break;
				if (Date.now() - cutAt > 5000) throw new Error("the storm did not end");
				await wait(10);
			}
			over = Date.now() - cutAt;
			const healed = await lab.sh("node1", "ping -c 1 -W 1 node2");
			const healedAt = Date.now() - cutAt;
			// By the capture's own clock: the row of the last cable that was cut, and the last frame that had looped.
			const lastLooped = await page.evaluate(() => {
				const { capture } = document.querySelector("unlab-app").services;
				let cut = 0;
				let looped = 0;
				for (let seq = capture.counters.in + 100_000; seq > 0 && cut === 0; seq--) {
					const e = capture.entry(seq);
					if (!e) continue;
					if (e.kind === "cable" && !e.up) cut = e.t;
					if (e.kind === "frame" && e.looped && looped === 0) looped = e.t;
				}
				return looped === 0 ? 0 : looped - cut;
			});
			const quiet = await lab.carried();
			await wait(500);
			const still = (await lab.carried()) - quiet;
			note("frames/s over the run", total);
			note("frames/s in the last 5 s", rates.at(-1));
			note("worst main-thread gap ms", probe.max);
			note("main-thread gap p99 ms", probe.p99);
			note("paints/s", probe.paints);
			note("renderers MB before", before);
			note("renderers MB at 5 s", memory[0]);
			note("renderers MB at the end", memory.at(-1));
			note("slowest lab command ms", Math.max(...answers.map(([listed]) => listed)));
			note("slowest guest echo ms", Math.max(...answers.map(([, echoed]) => echoed)));
			note("last looped frame after the cut ms", lastLooped);
			note("storm over after the cut ms", over);
			note("ping answered after the cut ms", healedAt);
			console.log(
				`run ${i} ${topology} ${seconds} s: ${total.toFixed(0)} frames/s; each 5 s: ${rates.join(" ")}\n` +
					`   main thread: worst gap ${probe.max.toFixed(1)} ms, p99 ${probe.p99.toFixed(1)} (n=${probe.n}), ${probe.paints.toFixed(0)} paints/s; threads: ${cpu}\n` +
					`   renderers MB: ${before.toFixed(0)} before, then each 5 s ${memory.join(" ")}\n` +
					`   lab command and guest echo ms, each 5 s: ${answers.map(([l, e]) => `${l}/${e}`).join(" ")}\n` +
					`   ${storms.join("; ")}\n` +
					`   after the cut: last looped frame ${lastLooped.toFixed(1)} ms, storm over ${over} ms, ping ${healed.exitCode === 0 ? "answered" : "LOST"} by ${healedAt} ms, ${still} frames in the next 0.5 s${lab.errors.length ? ` ERRORS ${lab.errors}` : ""}`,
			);
		});
	for (const [k, v] of Object.entries(all)) console.log(`${topology} ${k}: ${med(v, k.includes("ms") && !k.includes("slowest") ? 1 : 0)} n=${v.length}`);
}
process.exit(0);
