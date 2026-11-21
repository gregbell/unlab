import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { decode } from "./lab/decode.ts";
import { Lab, type DistroManifest } from "./lab/lab.ts";
import type { TapEvent } from "./lab/switch.ts";
import { renderTopology } from "./ui/topology.ts";

const MAX_PACKETS = 600;

interface TermView {
	term: Terminal;
	fit: FitAddon;
	el: HTMLDivElement;
}

const app = document.getElementById("app") as HTMLDivElement;
const terms = new Map<string, TermView>();
const packets: Array<TapEvent & { decoded: ReturnType<typeof decode> }> = [];

let lab: Lab;
let activeId: string | undefined;
let paused = false;
let filter = "";
let wireOpen = true;
let dirty = false;

function toast(message: string): void {
	const el = document.createElement("div");
	el.className = "toast";
	el.textContent = message;
	document.body.append(el);
	setTimeout(() => el.remove(), 6000);
}

/** Collapse repeated redraws into one per frame. */
function invalidate(): void {
	if (dirty) return;
	dirty = true;
	requestAnimationFrame(() => {
		dirty = false;
		renderSide();
		renderTabs();
		renderWire();
	});
}

// ---------------------------------------------------------------- structure

function shell(): void {
	app.innerHTML = `
		<header>
			<h1>un<span>lab</span></h1>
			<span class="meta" id="meta"></span>
			<span class="spacer"></span>
			<button class="ghost" id="toggle-wire">Hide wire</button>
		</header>
		<aside class="side">
			<h2>Machines</h2>
			<div class="add-form">
				<input type="text" id="new-name" placeholder="name (e.g. web1)" />
				<button class="primary" id="add">Add</button>
				<div class="row">
					<select id="new-distro"></select>
					<label title="Route non-lab traffic through a public Wisp proxy so apk works"><input type="checkbox" id="new-net" /> internet</label>
				</div>
			</div>
			<div id="machines"></div>
			<h2>MAC address table</h2>
			<div class="mac-table" id="macs"></div>
		</aside>
		<section class="main">
			<div class="tabs" id="tabs"></div>
			<div class="terms" id="terms"></div>
		</section>
		<section class="wire" id="wire">
			<h2>Topology</h2>
			<div id="topo"></div>
			<h2>The wire — every frame on the segment</h2>
			<div class="controls">
				<input type="text" id="pkt-filter" placeholder="filter: icmp, arp, 10.88.0.12 …" />
				<button id="pause">Pause</button>
				<button id="clear-pkts">Clear</button>
			</div>
			<div class="packets" id="packets"></div>
			<div class="stats" id="stats"></div>
		</section>`;

	byId("add").addEventListener("click", addMachine);
	byId<HTMLInputElement>("new-name").addEventListener("keydown", (e) => {
		if ((e as KeyboardEvent).key === "Enter") addMachine();
	});
	byId("toggle-wire").addEventListener("click", () => {
		wireOpen = !wireOpen;
		byId("wire").classList.toggle("hidden", !wireOpen);
		byId("toggle-wire").textContent = wireOpen ? "Hide wire" : "Show wire";
		fitActive();
	});
	byId("pause").addEventListener("click", () => {
		paused = !paused;
		byId("pause").textContent = paused ? "Resume" : "Pause";
	});
	byId("clear-pkts").addEventListener("click", () => {
		packets.length = 0;
		renderWire();
	});
	byId<HTMLInputElement>("pkt-filter").addEventListener("input", (e) => {
		filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
		renderWire();
	});
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

// ---------------------------------------------------------------- machines

function addMachine(): void {
	const nameEl = byId<HTMLInputElement>("new-name");
	const distro = byId<HTMLSelectElement>("new-distro").value;
	const internet = byId<HTMLInputElement>("new-net").checked;
	try {
		const m = lab.add({ name: nameEl.value, distro, internet });
		nameEl.value = "";
		select(m.id);
	} catch (e) {
		toast(e instanceof Error ? e.message : String(e));
	}
}

function select(id: string): void {
	activeId = id;
	ensureTerm(id);
	for (const [tid, v] of terms) v.el.classList.toggle("hidden", tid !== id);
	fitActive();
	invalidate();
}

function renderSide(): void {
	const host = byId("machines");
	host.innerHTML = "";
	for (const m of lab.machines) {
		const row = document.createElement("div");
		row.className = `machine ${m.state}${m.id === activeId ? " active" : ""}${m.link ? "" : " down"}`;
		row.innerHTML = `
			<div class="dot"></div>
			<div class="name"></div>
			<div class="acts">
				<button class="link" title="pull or plug the cable">${m.link ? "⇅" : "✕"}</button>
				<button class="kill" title="power off and remove">⌫</button>
			</div>
			<div class="ip"></div>
			<div class="status"></div>`;
		(row.querySelector(".name") as HTMLElement).textContent = m.name;
		(row.querySelector(".ip") as HTMLElement).textContent = `${m.ip}  ${m.mac}`;
		(row.querySelector(".status") as HTMLElement).textContent =
			m.state === "ready" ? `up in ${m.bootMs} ms${m.internet ? " · internet" : ""}` : m.status;
		row.addEventListener("click", () => select(m.id));
		(row.querySelector(".link") as HTMLElement).addEventListener("click", (e) => {
			e.stopPropagation();
			m.setLink(!m.link);
		});
		(row.querySelector(".kill") as HTMLElement).addEventListener("click", (e) => {
			e.stopPropagation();
			terms.get(m.id)?.term.dispose();
			terms.get(m.id)?.el.remove();
			terms.delete(m.id);
			lab.remove(m.id);
			if (activeId === m.id) activeId = lab.machines[0]?.id;
			if (activeId) select(activeId);
		});
		host.append(row);
	}

	const macs = byId("macs");
	const table = lab.sw.macTable();
	macs.innerHTML = table.length ? "" : `<div>nothing learned yet</div>`;
	for (const e of table.sort((a, b) => a.name.localeCompare(b.name))) {
		const d = document.createElement("div");
		d.innerHTML = `<span>${e.mac}</span><b>${e.name}</b>`;
		macs.append(d);
	}
}

function renderTabs(): void {
	const tabs = byId("tabs");
	tabs.innerHTML = "";
	for (const m of lab.machines) {
		const b = document.createElement("button");
		b.textContent = m.name;
		b.className = m.id === activeId ? "active" : "";
		b.addEventListener("click", () => select(m.id));
		tabs.append(b);
	}
	if (lab.machines.length > 1) {
		const sp = document.createElement("span");
		sp.className = "spacer";
		tabs.append(sp);
		const ping = document.createElement("button");
		ping.textContent = "ping the others";
		ping.addEventListener("click", pingOthers);
		tabs.append(ping);
	}
	if (!lab.machines.length) {
		byId("terms").innerHTML = `<div class="empty">
			<div>No machines yet. Add one on the left.</div>
			<div>Each machine is a real Linux kernel in its own thread, on one virtual switch.</div>
			<div>Try <code>ping node2</code> once you have two.</div>
		</div>`;
	}
}

/** Type a ping at the active machine's console, aimed at every other one. */
function pingOthers(): void {
	const m = activeId ? lab.byId(activeId) : undefined;
	if (!m) return;
	const others = lab.machines.filter((x) => x.id !== m.id);
	if (!others.length) return;
	m.write(`for h in ${others.map((o) => o.name).join(" ")}; do ping -c 2 -W 2 $h; done\n`);
}

// ---------------------------------------------------------------- terminals

function ensureTerm(id: string): TermView {
	const found = terms.get(id);
	if (found) return found;
	const m = lab.byId(id);
	if (!m) throw new Error(`no such machine: ${id}`);

	const el = document.createElement("div");
	el.className = "term";
	byId("terms").append(el);

	const term = new Terminal({
		convertEol: false,
		cursorBlink: true,
		fontFamily: `"Geist Mono", ui-monospace, Menlo, Consolas, monospace`,
		fontSize: 13,
		scrollback: 5000,
		theme: { background: "#000000", foreground: "#d7e0ea", cursor: "#5fd3bc" },
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(el);
	term.onData((d) => m.write(d));
	term.onResize(({ cols, rows }) => m.resize(cols, rows));

	// Whatever the machine printed before this terminal existed.
	for (const chunk of m.scrollback) term.write(chunk);

	const view: TermView = { term, fit, el };
	terms.set(id, view);
	return view;
}

function fitActive(): void {
	if (!activeId) return;
	const v = terms.get(activeId);
	if (!v) return;
	// After layout: the pane may have just changed width.
	requestAnimationFrame(() => {
		try {
			v.fit.fit();
		} catch {
			// A hidden or zero-sized pane: nothing to fit yet.
		}
	});
}

// ---------------------------------------------------------------- the wire

function renderWire(): void {
	if (!wireOpen) return;
	renderTopology(byId("topo"), lab, activeId, select);
	const host = byId("packets");
	const rows = filter ? packets.filter((p) => matches(p, filter)) : packets;
	const shown = rows.slice(-200);
	const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 30;

	host.innerHTML = shown
		.map((p) => {
			const d = p.decoded;
			return `<div class="pkt${p.flooded ? " flood" : ""}"><span class="t">${(p.t / 1000).toFixed(2)}</span><span class="p ${d.proto}">${d.proto}</span><span class="d">${esc(d.src)} <span class="arrow">&rarr;</span> ${esc(d.dst)} <span class="info">${esc(d.info)}</span></span></div>`;
		})
		.join("");
	if (atBottom) host.scrollTop = host.scrollHeight;

	let rx = 0;
	let tx = 0;
	let flooded = 0;
	for (const m of lab.machines) {
		const c = lab.sw.counters(m.id);
		if (!c) continue;
		rx += c.rxFrames;
		tx += c.txFrames;
		flooded += c.flooded;
	}
	byId("stats").textContent = `${lab.machines.length} machines · ${rx} frames in · ${tx} delivered · ${flooded} flooded${paused ? " · paused" : ""}`;
}

function matches(p: TapEvent & { decoded: ReturnType<typeof decode> }, q: string): boolean {
	const d = p.decoded;
	return `${d.proto} ${d.src} ${d.dst} ${d.info} ${p.fromName}`.toLowerCase().includes(q);
}

function esc(s: string): string {
	return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// ---------------------------------------------------------------- start

async function main(): Promise<void> {
	shell();

	const res = await fetch("distros/distros.json");
	if (!res.ok) {
		toast("No mirrored images. Run: node scripts/fetch-distros.ts alpine");
		return;
	}
	const manifest = (await res.json()) as DistroManifest;

	lab = new Lab({
		manifest,
		onChange: invalidate,
		onConsole: (m, bytes) => terms.get(m.id)?.term.write(bytes),
	});

	byId("meta").textContent = `${lab.subnet} · unkernel ${manifest.unkernel}`;
	const sel = byId<HTMLSelectElement>("new-distro");
	sel.innerHTML = manifest.distros
		.map((d) => `<option value="${d.name}">${d.name} — ${d.image.split("-").slice(0, 2).join(" ")}</option>`)
		.join("");

	lab.sw.onTap((e) => {
		if (paused) return;
		packets.push({ ...e, decoded: decode(e.frame) });
		if (packets.length > MAX_PACKETS) packets.splice(0, packets.length - MAX_PACKETS);
		invalidate();
	});

	new ResizeObserver(() => fitActive()).observe(byId("terms"));
	window.addEventListener("resize", fitActive);

	// Two machines, so the point of the place is visible at once.
	select(lab.add({ name: "node1" }).id);
	lab.add({ name: "node2" });
}

void main();
