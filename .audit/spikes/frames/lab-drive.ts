// Throwaway. Real guests in real Chromium. SPIKE_OUT=dir node lab-drive.ts normal|storm|conditions|hidden [runs]
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const out = process.env.SPIKE_OUT as string;
const [what, runsText] = process.argv.slice(2);
const runs = Number(runsText ?? 5);
const only = process.env.ONLY;
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
	try {
		const body = readFileSync(join(out, req.url as string));
		res.setHeader("content-type", types[extname(req.url ?? "")] ?? "application/octet-stream");
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
		res.end(body);
	} catch {
		res.statusCode = 404;
		res.setHeader("content-type", "text/html");
		res.end("<title>other</title>");
	}
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const executablePath = chromiumExecutable();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opt {
	design: "today" | "A" | "B" | "lean" | "zig";
	where: "main" | "worker";
	topology: string;
	machines: number;
	window: number;
	rxLimit: number;
	capture: boolean;
	image: string;
	[more: string]: unknown;
}
const opt = (o: Partial<Opt>): Opt => ({ design: "B", where: "main", topology: "one", machines: 2, window: 0, rxLimit: 0, capture: true, image: "alpine", ...o });

type Lab = {
	boot(o: unknown): Promise<void>;
	sh(m: number, line: string, ms?: number): Promise<{ ms: number; out: string }>;
	call(name: string, ...args: unknown[]): Promise<any>;
	probe(on: boolean): any;
	vmProbe(m: number): Promise<any>;
	storm(): Promise<void>;
	conditions(m: number, c: unknown): Promise<void>;
	captured(): any;
};
declare const window: { lab: Lab };

async function withLab<T>(o: Opt, fn: (l: Lab, page: Page, browser: Browser) => Promise<T>): Promise<T> {
	const browser = await chromium.launch({ executablePath });
	try {
		const page = await browser.newPage();
		const crashed: string[] = [];
		page.on("crash", () => crashed.push("page crashed"));
		page.on("pageerror", (e) => crashed.push(String(e)));
		await page.goto(`${origin}/lab.html`);
		await page.evaluate((o) => window.lab.boot(o), o);
		const lab = new Proxy({} as Lab, {
			get: (_, name: keyof Lab) => (...args: unknown[]) => page.evaluate(([name, args]) => (window.lab[name as keyof Lab] as (...a: unknown[]) => unknown)(...(args as unknown[])), [name, args] as const),
		});
		const got = await fn(lab, page, browser);
		if (crashed.length) console.log("ERRORS", crashed);
		return got;
	} finally {
		await browser.close();
	}
}
async function rss(browser: Browser): Promise<number> {
	const cdp = await browser.newBrowserCDPSession();
	const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
	await cdp.detach();
	return processInfo
		.filter((p) => p.type === "renderer")
		.reduce((sum, p) => sum + Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, "utf8"))?.[1] ?? 0) / 1024, 0);
}
const storm = Number(process.env.STORM_MS ?? 10_000);
/** Cores each busy thread of the renderer used over a second, by thread name. */
async function busy(browser: Browser): Promise<string> {
	const cdp = await browser.newBrowserCDPSession();
	const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
	await cdp.detach();
	const read = () => {
		const m = new Map<string, number>();
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
	return [...b].map(([k, v]) => [k, (v - (a.get(k) ?? 0)) / 100 / secs] as const).filter(([, v]) => v > 0.04).toSorted((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k.replace(/^\d+ /, "")} ${v.toFixed(2)}`).join(", ");
}
const q = (a: number[], p: number) => a.toSorted((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const med = (a: number[], d = 1) => `${q(a, 0.5).toFixed(d)} [${Math.min(...a).toFixed(d)}-${Math.max(...a).toFixed(d)}]`;
const times = (text: string) => [...text.matchAll(/time=([\d.]+)/g)].map((m) => Number(m[1]));

async function ping(lab: Lab, from: number, to: string, count: number, gap: string) {
	const { out } = await lab.sh(from, `sudo ping -c ${count} -i ${gap} -W 3 ${to}`, 90_000);
	const t = times(out);
	return { p50: q(t, 0.5) ?? NaN, p95: q(t, 0.95) ?? NaN, max: Math.max(...t), got: t.length, dup: /(\d+) duplicates/.exec(out)?.[1] ?? "0", tail: out.slice(-160) };
}
async function tcp(lab: Lab, mb: number, ms = 60_000) {
	const recv = lab.sh(1, "nc -l -p 9000 </dev/null >/dev/null", ms);
	await wait(300);
	await lab.call("reset");
	await lab.sh(0, `dd if=/dev/zero bs=64k count=${mb * 16} 2>/dev/null | nc -w 2 node2 9000`, ms);
	await recv;
	const s = await lab.call("stats");
	const seconds = (s.last[1] - s.first[1]) / 1000;
	// What the cable carried less 66 bytes of headers a frame. Nothing reads it in the guest, so that the link is what is measured.
	const bytes = s.bytes[1] - 66 * s.frames[1];
	return { bytes, mbit: (bytes * 8) / 1e6 / seconds, frames: s.frames[1], sizes: s.sizes, max: s.maxSize, drop: s.dropped, nicDropped: s.nicDropped };
}

const label = (o: Opt) => `${o.design}${o.design === "today" ? "" : `/${o.where}`} ${o.topology}${o.window ? ` window=${o.window} rx=${o.rxLimit}` : ""}${o.capture ? "" : " no capture"}${o.image === "alpine" ? "" : ` ${o.image}`}`;

const tag = (o: Opt) => label(o) + ["restMs", "ceiling", "pace", "flush", "clock"].filter((k) => o[k]).map((k) => ` ${k}=${o[k]}`).join("");

if (what === "normal") {
	const variants = [
		opt({ design: "today" }),
		opt({ design: "A" }),
		opt({ design: "B" }),
		opt({ design: "B", where: "worker" }),
		opt({ design: "B", where: "worker", window: 1024, rxLimit: 1024 }),
		opt({ design: "lean" }),
		opt({ design: "zig" }),
		opt({ design: "zig", where: "worker" }),
		opt({ design: "lean", where: "worker" }),
		opt({ design: "lean", topology: "two" }),
		opt({ design: "zig", topology: "two" }),
		opt({ design: "today", topology: "two" }),
		opt({ design: "A", topology: "two" }),
		opt({ design: "B", topology: "two" }),
		opt({ design: "B", where: "worker", topology: "two" }),
	].filter((o) => !only || only.split(",").some((s) => label(o).includes(s)));
	const got = variants.map(() => ({ rtt: [] as number[], p95: [] as number[], mbit: [] as number[] }));
	let sizes = "";
	for (let i = 0; i < runs; i++)
		for (const [v, o] of variants.entries())
			await withLab(o, async (lab) => {
				await ping(lab, 0, "node2", 20, "0.01");
				const p = await ping(lab, 0, "node2", 300, "0.01");
				await tcp(lab, 8);
				const t = await tcp(lab, 128);
				if (t.bytes < 128 * 2 ** 20 - 64 || t.bytes > 128 * 2 ** 20 + 2000 || p.got !== 300) console.log("SHORT", label(o), t.bytes, p.got, p.tail);
				got[v].rtt.push(p.p50);
				got[v].p95.push(p.p95);
				got[v].mbit.push(t.mbit);
				sizes = JSON.stringify({ sizes: t.sizes, max: t.max, frames: t.frames, drop: t.drop, nic: t.nicDropped });
				console.log(`  run ${i} ${label(o)}: rtt ${p.p50} p95 ${p.p95} ms, ${t.mbit.toFixed(0)} Mbit/s ${sizes}`);
			});
	for (const [v, o] of variants.entries()) console.log(`${label(o).padEnd(44)} rtt p50 ms ${med(got[v].rtt, 2)}  p95 ${med(got[v].p95, 2)}  TCP Mbit/s ${med(got[v].mbit, 0)}`);
}

if (what === "storm") {
	const bounded = { window: 1024, rxLimit: 1024 };
	const mesh = { topology: "mesh+pair", machines: 3 };
	const variants = [
		opt({ design: "A", topology: "triangle", ...bounded, flush: true }),
		opt({ topology: "triangle", ...bounded, flush: true }),
		opt({ topology: "triangle", flush: true, pace: 1000 }),
		opt({ topology: "triangle", flush: true, pace: 1000, where: "worker" }),
		opt({ design: "A", ...mesh, ...bounded, flush: true }),
		opt({ ...mesh, flush: true }),
		opt({ ...mesh, ...bounded, flush: true }),
		opt({ ...mesh, flush: true, pace: 1000 }),
		opt({ ...mesh, ...bounded, flush: true, where: "worker" }),
		opt({ ...mesh, flush: true, where: "worker", pace: 1000 }),
	].filter((o) => !only || tag(o).includes(only));
	for (let i = 0; i < runs; i++)
		for (const o of variants)
			await withLab(o, async (lab, page, browser) => {
				const tri = o.topology === "triangle";
				await ping(lab, 0, "node2", 5, "0.05");
				const before = await rss(browser);
				await lab.call("reset");
				await lab.probe(true);
				await lab.storm();
				const t0 = Date.now();
				await wait(1000);
				// A lab command that touches the page and one that a guest answers.
				const evals: number[] = [];
				for (let k = 0; k < 5; k++) {
					const t = Date.now();
					await page.evaluate("1+1");
					evals.push(Date.now() - t);
				}
				const hi = await lab.sh(1, "echo hi", 5000);
				const during = await ping(lab, 0, "node2", 20, "0.1");
				const s = await lab.call("stats");
				const secs = (Date.now() - t0) / 1000;
				const curve: number[] = [];
				for (let at = 5000; at <= storm; at += 5000) {
					while (Date.now() - t0 < at) await wait(50);
					curve.push(Math.round(await rss(browser)));
				}
				const cpu = await busy(browser);
				const vms = [await lab.vmProbe(0), await lab.vmProbe(1), ...(tri ? [] : [await lab.vmProbe(2)])];
				const gaps = await lab.probe(false);
				const cutAt = Date.now();
				for (let c = 0; c < (tri ? 1 : 6); c++) await lab.call("cut", c, false);
				const h1 = (await lab.call("stats")).hops;
				await wait(400);
				const s2 = await lab.call("stats");
				await wait(100);
				const s3 = await lab.call("stats");
				const macs = await lab.call("macs");
				const healed = await ping(lab, 0, "node2", 3, "0.2");
				const healedAt = Date.now() - cutAt;
				const hi2 = await lab.sh(1, "echo hi", 8000);
				console.log(
					`run ${i} ${tag(o)}\n` +
						`   hops/s ${(s.hops / secs).toFixed(0)}  paints/s ${gaps.paintsPerS.toFixed(0)}  page timer gap max ${gaps.max.toFixed(0)} p50 ${gaps.p50.toFixed(0)} ms (n=${gaps.n})  page.evaluate max ${Math.max(...evals)} ms  guest echo ${hi.ms.toFixed(0)} ms  ping during: ${during.got}/20 p50 ${during.p50} max ${during.max} dup ${during.dup}\n` +
						`   RSS ${before.toFixed(0)} -> ${curve.join(" ")} MB each 5 s  looped/s ${(s.looped / secs).toFixed(0)}  CPU ${cpu}  waiting ${s.waiting} maxDrain ${s.maxDrainMs.toFixed(1)}  dropped ${JSON.stringify(s.dropped)} nicDropped ${JSON.stringify(s.nicDropped)}\n` +
						`   vms ${JSON.stringify(vms)}\n` +
						`   after cut: last looped frame ${s3.stormOverMs.toFixed(0)} ms , frames 400-500 ms later ${s3.hops - s2.hops}; ping ${healed.got}/3 max ${healed.max} ms, done ${healedAt} ms after the cut; echo ${hi2.ms.toFixed(0)} ms; capture ${JSON.stringify(await lab.captured())}${healed.got < 3 ? ` MACS ${JSON.stringify(macs)}` : ""}`,
				);
			});
}

if (what === "conditions") {
	const variants = [opt({ where: "main", image: "lab" }), opt({ where: "main", clock: "worker", image: "lab" }), opt({ where: "worker", image: "lab" })].filter((o) => !only || only.split(",").some((s) => label(o).includes(s)));
	const all: Record<string, number[]> = {};
	const note = (k: string, v: number) => (all[k] ??= []).push(v);
	for (let i = 0; i < runs; i++)
		for (const o of variants)
			await withLab(o, async (lab) => {
				const L = tag(o);
				const base = await ping(lab, 0, "node2", 50, "0.02");
				for (const d of [5, 100, 1000]) {
					await lab.conditions(1, { delayMs: d });
					await lab.call("reset");
					const p = await ping(lab, 0, "node2", d === 1000 ? 5 : 30, d === 5 ? "0.02" : "0.2");
					note(`${L} delay ${d}: RTT minus base minus 2x`, p.p50 - base.p50 - 2 * d);
					const late = await lab.call("stats");
					note(`${L} delay ${d}: frames handed on late, mean ms`, late.sumLate / late.late);
					note(`${L} delay ${d}: frames handed on late, worst ms`, late.maxLate);
					if (p.got < (d === 1000 ? 5 : 30)) console.log("SHORT", L, d, p.tail);
				}
				if (process.env.DELAYS) return;
				await lab.conditions(1, { delayMs: 20, reorder: 0.25 });
				const r = await lab.sh(0, "sudo ping -c 200 -i 0.005 -W 1 node2", 60_000);
				const seqs = [...r.out.matchAll(/seq=(\d+)/g)].map((m) => Number(m[1]));
				note(`${L} reorder 25%: replies out of order of 200`, seqs.filter((s, k) => k && s < seqs[k - 1]).length);
				await lab.conditions(1, { mtu: 1000 });
				const big = await lab.sh(0, "ping -c 2 -W 1 -s 1200 node2; ping -c 2 -W 1 -s 900 node2");
				note(`${L} mtu 1000: answers to -s 1200`, Number(/(\d+) (packets )?received/.exec(big.out)?.[1]));
				note(`${L} mtu 1000: answers to -s 900`, Number([...big.out.matchAll(/(\d+) (?:packets )?received/g)][1]?.[1]));
				await lab.conditions(1, { loss: 0.2 });
				await lab.call("reset");
				const t0 = Date.now();
				const s0 = await lab.call("stats");
				await lab.sh(0, "sudo ping -c 1000 -i 0.002 -W 1 node2 | tail -2", 120_000);
				const s1 = await lab.call("stats");
				const drop = (s: any, name: string) => s.cableDrop.find((c: any) => c[0] === name)?.[2].loss ?? 0;
				const lost = drop(s1, "sw>m1") - drop(s0, "sw>m1");
				note(`${L} loss 20%: share of ${"1000"} requests lost toward node2, percent`, lost / 10);
				note(`${L} loss 20%: seconds for 1000 pings`, (Date.now() - t0) / 1000);
				await lab.conditions(1, { rate: 1_000_000 });
				const t = await tcp(lab, 1, 120_000);
				note(`${L} rate 1 Mbit/s: TCP payload Mbit/s`, t.mbit);
				note(`${L} rate 1 Mbit/s: frames dropped by the queue`, t.drop.rate ?? 0);
				await lab.conditions(1, { rate: 10_000_000 });
				const t10 = await tcp(lab, 8, 120_000);
				note(`${L} rate 10 Mbit/s: TCP payload Mbit/s`, t10.mbit);
				await lab.conditions(1, null);
				const t2 = await tcp(lab, 32);
				note(`${L} cleared: TCP Mbit/s`, t2.mbit);
				if (t.bytes < 2 ** 20 - 64) console.log("SHORT", t.bytes);
			});
	for (const [k, v] of Object.entries(all)) console.log(`${k}: ${med(v, 2)} n=${v.length}`);
}
if (what === "profile") {
	// Where a transfer's time goes. Not a reported speed: the profiler slows the page.
	for (const o of [opt({ design: "today" }), opt({ design: "today", topology: "two" }), opt({ design: "B", topology: "two" }), opt({ design: "lean", topology: "two" }), opt({ design: "zig", topology: "two" }), opt({ design: "B", where: "worker" })].filter((o) => !only || tag(o).includes(only)))
		for (let i = 0; i < runs; i++)
			await withLab(o, async (lab, page, browser) => {
				await ping(lab, 0, "node2", 20, "0.01");
				await tcp(lab, 8);
				const transfer = tcp(lab, 400);
				await wait(1200);
				const cpu = await busy(browser);
				const t = await transfer;
				const cdp = await page.context().newCDPSession(page);
				await cdp.send("Profiler.enable");
				await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
				const second = tcp(lab, 400);
				await wait(1200);
				await cdp.send("Profiler.start");
				await wait(1500);
				const { profile } = await cdp.send("Profiler.stop");
				await second;
				const self = new Map<string, number>();
				const name = new Map(profile.nodes.map((n: any) => [n.id, n.callFrame.functionName || "(anonymous " + n.callFrame.url.split("/").pop() + ":" + n.callFrame.lineNumber + ":" + n.callFrame.columnNumber + ")"]));
				const total = profile.samples?.length ?? 0;
				for (const s of profile.samples ?? []) self.set(name.get(s) as string, (self.get(name.get(s) as string) ?? 0) + 1);
				console.log(`${tag(o)}: ${t.mbit.toFixed(0)} Mbit/s ${t.frames} frames; threads: ${cpu}`);
				console.log("   main thread, self share: " + [...self].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `${k} ${((100 * v) / total).toFixed(1)}%`).join(", "));
			});
}

if (what === "ui")
	for (let i = 0; i < runs; i++)
		for (const o of [opt({ design: "today" }), opt({ where: "worker" })])
			await withLab(o, async (lab, page) => {
				await tcp(lab, 8);
				const transfer = tcp(lab, 400);
				await wait(800);
				await lab.probe(true);
				const evals: number[] = [];
				for (let k = 0; k < 20; k++) {
					const t = Date.now();
					await page.evaluate("1+1");
					evals.push(Date.now() - t);
					await wait(50);
				}
				const g = await lab.probe(false);
				console.log(`${label(o)}: paints/s ${g.paintsPerS.toFixed(0)}, timer gap p50 ${g.p50.toFixed(1)} max ${g.max.toFixed(0)} ms, evaluate max ${Math.max(...evals)} ms, ${(await transfer).mbit.toFixed(0)} Mbit/s`);
			});

if (what === "loss")
	// 10,000 UDP frames at once, counted at the cable and again by the receiving kernel.
	await withLab(opt({ clock: "worker" }), async (lab) => {
		await ping(lab, 0, "node2", 5, "0.1");
		await lab.conditions(1, { loss: 0.2 });
		const rx = async () => Number((await lab.sh(1, "cat /sys/class/net/eth0/statistics/rx_packets")).out);
		const lost = async () => (await lab.call("stats")).cableDrop.find((c: any) => c[0] === "sw>m1")?.[2].loss ?? 0;
		for (let i = 0; i < runs; i++) {
			const [r0, l0, t0] = [await rx(), await lost(), Date.now()];
			await lab.call("reset");
			await lab.sh(0, "dd if=/dev/zero bs=1000 count=10000 2>/dev/null | nc -u -w 1 node2 9 ; sleep 0.3");
			const [r, l] = [(await rx()) - r0, (await lost()) - l0];
			console.log(`got ${r}, cable lost ${l}, sum ${r + l}, share ${((100 * l) / (r + l)).toFixed(2)}%, ${Date.now() - t0} ms`);
		}
	});

if (what === "debug") await withLab(opt({ design: "today" }), async (lab) => {
	const recv = lab.sh(1, "nc -l -p 9000 </dev/null | wc -c", 15000);
	await wait(1500);
	console.log(await lab.sh(0, "time dd if=/dev/zero bs=64k count=160 | nc -w 2 node2 9000", 15000));
	console.log(await recv);
	console.log(await lab.call("stats"));
	console.log(await lab.sh(1, "ss -ltn; netstat -ltn", 5000));
});
server.closeAllConnections();
server.close();
process.exit(0);
