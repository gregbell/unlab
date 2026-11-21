// The terminal's stylesheet first, so ours can override it.
import "@wterm/dom/css";
import "./style.css";

import { Lab, type DistroManifest } from "./lab/lab.ts";
import type { Machine, Session } from "./lab/machine.ts";
import { badgeColor, renderDetail, renderMachines, type SidebarHandlers } from "./ui/sidebar.ts";
import { TerminalPane } from "./ui/terminal.ts";
import { renderTopology } from "./ui/topology.ts";
import { MAX_PACKETS, renderMacTable, renderPackets, renderStats, toPacket, type Packet } from "./ui/wire.ts";

interface Tab {
	session: Session;
	pane: TerminalPane;
}

const app = document.getElementById("app") as HTMLDivElement;
const tabs: Tab[] = [];
const packets: Packet[] = [];

let lab: Lab;
let activeSessionId: string | undefined;
let selectedMachineId: string | undefined;
let paused = false;
let filter = "";
let wireOpen = true;
let dirty = false;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

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
		render();
	});
}

// ------------------------------------------------------------------ layout

function shell(): void {
	app.innerHTML = `
		<header class="topbar">
			<div class="brand">un<span>lab</span></div>
			<div class="tabstrip" id="tabstrip"></div>
			<div class="right">
				<button id="new-shell" title="New shell on the selected machine">+</button>
				<button id="toggle-wire" title="Show or hide the network inspector">Wire</button>
			</div>
		</header>

		<aside class="side">
			<div class="sect">Machines <button id="add" title="Add a machine">+</button></div>
			<div class="addrow"><input type="text" id="new-name" placeholder="name (e.g. web1)" /></div>
			<div class="opts">
				<select id="new-distro"></select>
				<label title="Route non-lab traffic through a public Wisp proxy so apk works">
					<input type="checkbox" id="new-net" /> internet
				</label>
			</div>
			<div class="machines" id="machines"></div>
			<div class="sect top">Machine</div>
			<div class="detail" id="detail"></div>
		</aside>

		<section class="main">
			<div class="panes" id="panes"></div>
			<div class="nothing" id="nothing">
				<b>No terminal open</b>
				<div>Pick a machine on the left, or press <code>+</code> for another shell.</div>
			</div>
		</section>

		<section class="wire" id="wire">
			<div class="sect">Topology</div>
			<div id="topo"></div>
			<div class="sect">The wire</div>
			<div class="controls">
				<input type="text" id="pkt-filter" placeholder="filter: icmp, arp, 10.88.0.12 …" />
				<button id="pause" title="Stop collecting frames">Pause</button>
				<button id="clear-pkts">Clear</button>
			</div>
			<div class="packets" id="packets"></div>
			<div class="stats" id="stats"></div>
		</section>`;

	byId("add").addEventListener("click", addMachine);
	byId<HTMLInputElement>("new-name").addEventListener("keydown", (e) => {
		if ((e as KeyboardEvent).key === "Enter") addMachine();
	});
	byId("new-shell").addEventListener("click", () => {
		const m = selectedMachine();
		if (m) handlers.newShell(m);
	});
	byId("toggle-wire").addEventListener("click", () => {
		wireOpen = !wireOpen;
		byId("wire").classList.toggle("hidden", !wireOpen);
		byId("toggle-wire").classList.toggle("on", wireOpen);
		fitActive();
		invalidate();
	});
	byId("toggle-wire").classList.toggle("on", wireOpen);
	byId("pause").addEventListener("click", () => {
		paused = !paused;
		byId("pause").textContent = paused ? "Resume" : "Pause";
		invalidate();
	});
	byId("clear-pkts").addEventListener("click", () => {
		packets.length = 0;
		invalidate();
	});
	byId<HTMLInputElement>("pkt-filter").addEventListener("input", (e) => {
		filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
		invalidate();
	});
}

// ----------------------------------------------------------------- machines

function selectedMachine(): Machine | undefined {
	return selectedMachineId ? lab.byId(selectedMachineId) : undefined;
}

function addMachine(): void {
	const nameEl = byId<HTMLInputElement>("new-name");
	try {
		const m = lab.add({
			name: nameEl.value,
			distro: byId<HTMLSelectElement>("new-distro").value,
			internet: byId<HTMLInputElement>("new-net").checked,
		});
		nameEl.value = "";
		selectedMachineId = m.id;
		void openTab(m.console);
	} catch (e) {
		toast(e instanceof Error ? e.message : String(e));
	}
}

const handlers: SidebarHandlers = {
	selectMachine: (id) => {
		selectedMachineId = id;
		// Show something from that machine: a tab it already has, or its console.
		const existing = tabs.find((t) => t.session.machine.id === id);
		void openTab(existing ? existing.session : lab.byId(id)?.console);
	},
	openSession: (s) => void openTab(s),
	newShell: (m) => {
		if (m.state !== "ready") {
			toast(`${m.name} is not up yet`);
			return;
		}
		void openTab(m.openShell());
	},
	removeMachine: (m) => {
		for (const t of tabs.filter((t) => t.session.machine.id === m.id)) closeTab(t, false);
		lab.remove(m.id);
		if (selectedMachineId === m.id) selectedMachineId = lab.machines[0]?.id;
		invalidate();
	},
	pingOthers: (m) => {
		const others = lab.machines.filter((x) => x.id !== m.id);
		if (!others.length) return;
		const s = tabs.find((t) => t.session.machine.id === m.id)?.session ?? m.console;
		void openTab(s).then(() => s.write(`for h in ${others.map((o) => o.name).join(" ")}; do ping -c 2 -W 2 $h; done\n`));
	},
};

// --------------------------------------------------------------------- tabs

async function openTab(session: Session | undefined): Promise<void> {
	if (!session) return;
	selectedMachineId = session.machine.id;
	const found = tabs.find((t) => t.session.id === session.id);
	if (found) {
		activate(session.id);
		return;
	}
	const pane = new TerminalPane(session);
	const tab: Tab = { session, pane };
	tabs.push(tab);
	activeSessionId = session.id;
	// Hide the pane that was showing before the new one mounts, or both paint.
	applyActive();
	invalidate();
	await pane.mount(byId("panes"), activeSessionId === session.id);
	// Another tab may have been opened while the WASM core loaded.
	applyActive();
	invalidate();
}

/** Exactly one pane paints: the active one. */
function applyActive(): void {
	for (const t of tabs) t.pane.setActive(t.session.id === activeSessionId);
}

function activate(sessionId: string): void {
	activeSessionId = sessionId;
	applyActive();
	const t = tabs.find((x) => x.session.id === sessionId);
	if (t) selectedMachineId = t.session.machine.id;
	invalidate();
}

function closeTab(tab: Tab, pick = true): void {
	const i = tabs.indexOf(tab);
	if (i < 0) return;
	tabs.splice(i, 1);
	tab.pane.destroy();
	// A shell belongs to its tab; the console belongs to the machine.
	if (tab.session.kind === "shell") tab.session.close();
	if (pick && activeSessionId === tab.session.id) {
		const next = tabs[Math.min(i, tabs.length - 1)];
		if (next) activate(next.session.id);
		else activeSessionId = undefined;
	}
	invalidate();
}

function renderTabs(): void {
	const strip = byId("tabstrip");
	strip.textContent = "";
	for (const t of tabs) {
		const m = t.session.machine;
		const el = document.createElement("div");
		el.className = `tab${t.session.id === activeSessionId ? " active" : ""}`;

		const badge = document.createElement("span");
		badge.className = "badge";
		badge.style.background = badgeColor(lab, m);
		badge.textContent = m.name.slice(0, 1);

		const label = document.createElement("span");
		label.className = "label";
		const b = document.createElement("b");
		b.textContent = m.name;
		const i = document.createElement("i");
		i.textContent = ` ${t.session.label}`;
		label.append(b, i);

		const dot = document.createElement("span");
		dot.className = `dot ${t.session.state === "open" ? m.state : t.session.state}`;

		const close = document.createElement("button");
		close.className = "close";
		close.textContent = "×";
		close.title = t.session.kind === "shell" ? "Close this shell" : "Close this tab";
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			closeTab(t);
		});

		el.append(badge, label, dot, close);
		el.addEventListener("click", () => activate(t.session.id));
		strip.append(el);
	}
	byId("nothing").style.display = tabs.length ? "none" : "grid";
}

function fitActive(): void {
	const t = tabs.find((x) => x.session.id === activeSessionId);
	if (!t) return;
	requestAnimationFrame(() => t.pane.fit());
}

// ------------------------------------------------------------------- render

function render(): void {
	renderTabs();
	renderMachines(byId("machines"), lab, selectedMachineId, handlers);
	renderDetail(byId("detail"), lab, selectedMachine(), new Set(tabs.map((t) => t.session.id)), handlers);
	byId<HTMLButtonElement>("new-shell").disabled = selectedMachine()?.state !== "ready";
	if (!wireOpen) return;
	renderTopology(byId("topo"), lab, selectedMachineId, (id) => handlers.selectMachine(id));
	renderPackets(byId("packets"), packets, filter);
	renderStats(byId("stats"), lab, paused);
	renderMacTable(byId("mac"), lab);
}

// -------------------------------------------------------------------- start

async function main(): Promise<void> {
	shell();

	const res = await fetch("distros/distros.json");
	if (!res.ok) {
		toast("No mirrored images. Run: node scripts/fetch-distros.ts alpine");
		return;
	}
	const manifest = (await res.json()) as DistroManifest;

	lab = new Lab({ manifest, onChange: invalidate });

	document.title = `unlab — ${lab.subnet}`;
	const sel = byId<HTMLSelectElement>("new-distro");
	sel.innerHTML = manifest.distros
		.map((d) => `<option value="${d.name}">${d.name} — ${d.image.split("-").slice(0, 2).join(" ")}</option>`)
		.join("");

	// The MAC table lives under the stats line; it is added here so the panel's
	// grid rows stay in the markup above.
	const mac = document.createElement("div");
	mac.className = "mac";
	mac.id = "mac";
	byId("stats").after(mac);

	lab.sw.onTap((e) => {
		if (paused) return;
		packets.push(toPacket(e));
		if (packets.length > MAX_PACKETS) packets.splice(0, packets.length - MAX_PACKETS);
		invalidate();
	});

	new ResizeObserver(() => fitActive()).observe(byId("panes"));
	window.addEventListener("resize", fitActive);

	// Two machines, so the point of the place is visible at once.
	const first = lab.add({ name: "node1" });
	lab.add({ name: "node2" });
	selectedMachineId = first.id;
	await openTab(first.console);
}

void main();
